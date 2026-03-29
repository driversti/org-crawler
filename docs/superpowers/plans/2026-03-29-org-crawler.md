# Org Crawler v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dockerized Node.js crawler that scans eRepublik citizen IDs, identifies organization accounts, and saves them to CSV — running behind Gluetun VPN with automatic IP rotation.

**Architecture:** Single `app.js` entry point with helper modules for Telegram, VPN control, CSV I/O, and the main crawl loop. Docker image pushed to `registry.yurii.live/org-crawler`, deployed via `docker-compose.yml` using Gluetun's network stack.

**Tech Stack:** Node.js 18 (ESM), got-scraping 4.x, csv-writer, Docker + Gluetun + Surfshark

---

## File Map

| File | Responsibility |
|------|----------------|
| `app.js` | Entry point: startup sequence, main scan loop, graceful shutdown |
| `lib/telegram.js` | Send messages to Telegram topic (with silent failure when VPN is down) |
| `lib/vpn.js` | Gluetun API: reconnect, poll status, verify IP, IP leak check |
| `lib/csv-io.js` | Read/write checkpoint.txt, append to orgs.csv and failed.csv |
| `lib/config.js` | Parse and validate env vars |
| `package.json` | Dependencies and scripts |
| `Dockerfile` | Multi-stage Node.js 18 Alpine image |
| `docker-compose.yml` | Crawler + Gluetun services |
| `.env.example` | Template for all env vars |
| `release.sh` | Build + push multi-arch image to registry |
| `.gitignore` | Ignore data/, node_modules/, .env |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "org-crawler",
  "version": "2.0.0",
  "description": "eRepublik organization account crawler",
  "main": "app.js",
  "type": "module",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "csv-writer": "^1.6.0",
    "got-scraping": "^4.1.2"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
data/
.env
gluetun/
```

- [ ] **Step 3: Create .env.example**

```env
# Crawler
START_ID=1
END_ID=13000000
BASE_DELAY_MS=100

# Telegram (optional — if omitted, notifications are skipped)
BOT_TOKEN=
CHAT_ID=
TOPIC_ID=

# Gluetun / Surfshark
VPN_SERVICE_PROVIDER=surfshark
VPN_TYPE=openvpn
OPENVPN_USER=
OPENVPN_PASSWORD=
SERVER_COUNTRIES=
```

- [ ] **Step 4: Install dependencies**

Run: `cd org-crawler && npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example
git commit -m "chore: scaffold org-crawler project"
```

---

### Task 2: Config Module

**Files:**
- Create: `lib/config.js`

- [ ] **Step 1: Create lib/config.js**

```js
const required = (name) => {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
};

const config = {
  startId: parseInt(required('START_ID'), 10),
  endId: parseInt(required('END_ID'), 10),
  baseDelayMs: parseInt(process.env.BASE_DELAY_MS || '100', 10),

  // Telegram (all optional — if any missing, notifications are silently skipped)
  botToken: process.env.BOT_TOKEN || null,
  chatId: process.env.CHAT_ID || null,
  topicId: process.env.TOPIC_ID || null,

  // Paths
  dataDir: './data',
  checkpointPath: './data/checkpoint.txt',
  orgsCsvPath: './data/orgs.csv',
  failedCsvPath: './data/failed.csv',

  // Backoff
  backoffSteps: [1000, 2000, 4000, 8000, 16000],
  jitterPercent: 0.3,
  maxVpnRotationsPerRequest: 3,

  // VPN
  gluetunApiUrl: 'http://localhost:8000',
  vpnPollIntervalMs: 2000,
  vpnPollTimeoutMs: 30000,
  vpnSleepOnFailureMs: 5 * 60 * 1000,

  // Progress
  progressEveryN: 10000,
};

if (isNaN(config.startId) || isNaN(config.endId)) {
  console.error('START_ID and END_ID must be integers');
  process.exit(1);
}

export default config;
```

- [ ] **Step 2: Verify module loads**

Run: `START_ID=1 END_ID=100 node -e "import('./lib/config.js').then(m => console.log(m.default))"`
Expected: Config object printed with startId=1, endId=100.

- [ ] **Step 3: Commit**

```bash
git add lib/config.js
git commit -m "feat: add config module with env var parsing"
```

---

### Task 3: Telegram Module

**Files:**
- Create: `lib/telegram.js`

- [ ] **Step 1: Create lib/telegram.js**

```js
import { gotScraping } from 'got-scraping';
import config from './config.js';

const canSend = config.botToken && config.chatId;

export async function sendTelegram(message) {
  if (!canSend) return;

  try {
    const body = {
      chat_id: config.chatId,
      text: message,
      parse_mode: 'HTML',
    };
    if (config.topicId) {
      body.message_thread_id = parseInt(config.topicId, 10);
    }

    await gotScraping.post(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      json: body,
      responseType: 'json',
      timeout: { request: 10000 },
    });
  } catch (err) {
    // VPN may be down — log to stdout only, never throw
    console.error(`[telegram] Failed to send: ${err.message}`);
  }
}
```

- [ ] **Step 2: Verify module loads**

Run: `START_ID=1 END_ID=100 node -e "import('./lib/telegram.js').then(m => console.log('loaded, canSend:', typeof m.sendTelegram))"`
Expected: `loaded, canSend: function`

- [ ] **Step 3: Commit**

```bash
git add lib/telegram.js
git commit -m "feat: add Telegram notification module with topic support"
```

---

### Task 4: CSV I/O Module

**Files:**
- Create: `lib/csv-io.js`

- [ ] **Step 1: Create lib/csv-io.js**

```js
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createObjectCsvWriter } from 'csv-writer';
import config from './config.js';

// Ensure data directory exists
mkdirSync(config.dataDir, { recursive: true });

const orgsCsvWriter = createObjectCsvWriter({
  path: config.orgsCsvPath,
  header: [
    { id: 'id', title: 'ID' },
    { id: 'name', title: 'Name' },
    { id: 'created_at', title: 'Created At' },
    { id: 'country', title: 'Country' },
  ],
  append: true,
});

const failedCsvWriter = createObjectCsvWriter({
  path: config.failedCsvPath,
  header: [
    { id: 'id', title: 'ID' },
    { id: 'error', title: 'Error' },
    { id: 'timestamp', title: 'Timestamp' },
  ],
  append: true,
});

export function readCheckpoint() {
  try {
    if (!existsSync(config.checkpointPath)) return null;
    const content = readFileSync(config.checkpointPath, 'utf-8').trim();
    const id = parseInt(content, 10);
    return isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

export function writeCheckpoint(id) {
  writeFileSync(config.checkpointPath, String(id));
}

export async function appendOrg(org) {
  await orgsCsvWriter.writeRecords([org]);
}

export async function appendFailed(id, error) {
  await failedCsvWriter.writeRecords([{
    id,
    error,
    timestamp: new Date().toISOString(),
  }]);
}
```

- [ ] **Step 2: Test checkpoint round-trip**

Run:
```bash
START_ID=1 END_ID=100 node -e "
import { readCheckpoint, writeCheckpoint } from './lib/csv-io.js';
console.log('initial:', readCheckpoint());
writeCheckpoint(42);
console.log('after write:', readCheckpoint());
"
```
Expected:
```
initial: null
after write: 42
```

- [ ] **Step 3: Commit**

```bash
git add lib/csv-io.js
git commit -m "feat: add CSV I/O module with checkpoint, orgs, and failed writers"
```

---

### Task 5: VPN Control Module

**Files:**
- Create: `lib/vpn.js`

- [ ] **Step 1: Create lib/vpn.js**

```js
import { gotScraping } from 'got-scraping';
import config from './config.js';
import { sendTelegram } from './telegram.js';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getCurrentIp() {
  const response = await gotScraping.get('https://api.ipify.org?format=json', {
    responseType: 'json',
    timeout: { request: 10000 },
  });
  return response.body.ip;
}

export async function getIpCountry(ip) {
  const response = await gotScraping.get(`http://ip-api.com/json/${ip}`, {
    responseType: 'json',
    timeout: { request: 10000 },
  });
  return response.body.country;
}

export async function checkIpLeak() {
  const ip = await getCurrentIp();
  const country = await getIpCountry(ip);
  console.log(`[vpn] Current IP: ${ip} (${country})`);

  if (country === 'Poland') {
    const msg = '🚨 IP LEAK: detected Poland IP. Exiting immediately.';
    console.error(msg);
    await sendTelegram(msg);
    process.exit(1);
  }

  return { ip, country };
}

async function setVpnStatus(status) {
  await gotScraping.put(`${config.gluetunApiUrl}/v1/openvpn/status`, {
    json: { status },
    timeout: { request: 10000 },
  });
}

async function getVpnStatus() {
  const response = await gotScraping.get(`${config.gluetunApiUrl}/v1/openvpn/status`, {
    responseType: 'json',
    timeout: { request: 5000 },
  });
  return response.body.status;
}

async function pollVpnUntilRunning() {
  const deadline = Date.now() + config.vpnPollTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await getVpnStatus();
      if (status === 'running') return true;
    } catch {
      // Gluetun may not be responding yet
    }
    await sleep(config.vpnPollIntervalMs);
  }
  return false;
}

/**
 * Rotate VPN: stop → start → poll → verify new IP.
 * Returns { success, newIp } or { success: false }.
 */
async function attemptRotation() {
  try {
    console.log('[vpn] Stopping VPN...');
    await setVpnStatus('stopped');
    await sleep(2000);

    console.log('[vpn] Starting VPN...');
    await setVpnStatus('running');

    const connected = await pollVpnUntilRunning();
    if (!connected) {
      console.error('[vpn] Timed out waiting for VPN to reconnect');
      return { success: false };
    }

    // Brief pause for network to stabilize
    await sleep(2000);

    const newIp = await getCurrentIp();
    console.log(`[vpn] New IP: ${newIp}`);
    return { success: true, newIp };
  } catch (err) {
    console.error(`[vpn] Rotation attempt failed: ${err.message}`);
    return { success: false };
  }
}

/**
 * Rotate VPN with retries. On total failure, sleep and retry indefinitely.
 * Returns the new IP address.
 */
export async function rotateVpn(oldIp) {
  while (true) {
    // Try up to 3 rotation attempts
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[vpn] Rotation attempt ${attempt}/3...`);
      const result = await attemptRotation();
      if (result.success) {
        const msg = `🔄 VPN rotated: ${oldIp} → ${result.newIp}`;
        console.log(msg);
        await sendTelegram(msg);
        return result.newIp;
      }
    }

    // All 3 attempts failed — sleep and retry
    const msg = '⚠️ VPN reconnect failed 3x. Sleeping 5min.';
    console.error(msg);
    // Telegram send will likely fail too (no network), but try anyway
    await sendTelegram(msg);
    await sleep(config.vpnSleepOnFailureMs);
  }
}
```

- [ ] **Step 2: Verify module loads**

Run: `START_ID=1 END_ID=100 node -e "import('./lib/vpn.js').then(m => console.log('loaded:', Object.keys(m)))"`
Expected: `loaded: [ 'getCurrentIp', 'getIpCountry', 'checkIpLeak', 'rotateVpn' ]`

- [ ] **Step 3: Commit**

```bash
git add lib/vpn.js
git commit -m "feat: add VPN control module with Gluetun API rotation"
```

---

### Task 6: Main Crawler (app.js)

**Files:**
- Create: `app.js`

- [ ] **Step 1: Create app.js**

```js
import { gotScraping } from 'got-scraping';
import config from './lib/config.js';
import { sendTelegram } from './lib/telegram.js';
import { readCheckpoint, writeCheckpoint, appendOrg, appendFailed } from './lib/csv-io.js';
import { checkIpLeak, getCurrentIp, rotateVpn } from './lib/vpn.js';

const API_URL = 'https://www.erepublik.com/en/main/citizen-profile-json-global/';

// Stats
let orgsFound = 0;
let errorCount = 0;
let startTime;
let currentId;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms) {
  const jitter = ms * config.jitterPercent;
  return ms + (Math.random() * 2 - 1) * jitter;
}

function isCloudflareResponse(body) {
  if (typeof body !== 'string') return false;
  return body.includes('Cloudflare') || body.includes('cf-browser-verification') || body.includes('challenge-platform');
}

function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

async function fetchCitizen(citizenId) {
  const response = await gotScraping.get(`${API_URL}${citizenId}`, {
    responseType: 'json',
    timeout: { request: 15000 },
  });

  // got-scraping may return string body if server sends HTML instead of JSON
  if (typeof response.body === 'string') {
    if (isCloudflareResponse(response.body)) {
      throw Object.assign(new Error('Cloudflare challenge detected'), { code: 'CLOUDFLARE' });
    }
    throw Object.assign(new Error('Non-JSON response'), { code: 'BAD_RESPONSE' });
  }

  return response.body;
}

function isRetryableError(err) {
  if (err.code === 'CLOUDFLARE' || err.code === 'BAD_RESPONSE') return true;
  if (err.response) {
    const status = err.response.statusCode;
    return status === 403 || status === 429 || status >= 500;
  }
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
  return !err.response || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';
}

function is404(err) {
  return err.response && err.response.statusCode === 404;
}

async function processId(citizenId, currentIp) {
  let ip = currentIp;

  for (let vpnRotation = 0; vpnRotation < config.maxVpnRotationsPerRequest; vpnRotation++) {
    for (let retry = 0; retry < config.backoffSteps.length; retry++) {
      try {
        const data = await fetchCitizen(citizenId);

        if (data.citizen && data.citizen.is_organization) {
          const org = {
            id: data.citizen.id,
            name: data.citizen.name,
            created_at: data.citizen.created_at,
            country: data.location?.citizenshipCountry?.name || 'Unknown',
          };
          await appendOrg(org);
          orgsFound++;
          const msg = `🏢 Found org: ${org.name} (ID: ${org.id}, ${org.country})`;
          console.log(msg);
          await sendTelegram(msg);
        }

        return ip; // success
      } catch (err) {
        if (is404(err)) return ip; // expected — skip silently

        if (!isRetryableError(err)) {
          // Unexpected error — log and move on
          errorCount++;
          await appendFailed(citizenId, err.message);
          console.error(`[error] ID ${citizenId}: ${err.message}`);
          return ip;
        }

        // Retryable error — backoff
        const delay = withJitter(config.backoffSteps[retry]);
        console.warn(`[retry] ID ${citizenId}: ${err.message} (retry ${retry + 1}/${config.backoffSteps.length}, wait ${Math.round(delay)}ms)`);
        await sleep(delay);
      }
    }

    // All backoff retries exhausted — rotate VPN
    console.warn(`[vpn] Backoff exhausted for ID ${citizenId}. Rotating VPN (attempt ${vpnRotation + 1}/${config.maxVpnRotationsPerRequest})...`);
    ip = await rotateVpn(ip);
  }

  // All VPN rotations exhausted for this ID
  errorCount++;
  const errorMsg = `All retries + ${config.maxVpnRotationsPerRequest} VPN rotations exhausted`;
  await appendFailed(citizenId, errorMsg);
  const msg = `❌ Gave up on ID ${citizenId}: ${errorMsg}`;
  console.error(msg);
  await sendTelegram(msg);
  return ip;
}

async function sendProgress(current) {
  const elapsed = Date.now() - startTime;
  const processed = current - config.startId;
  const total = config.endId - config.startId + 1;
  const pct = ((processed / total) * 100).toFixed(1);
  const speed = processed > 0 ? ((processed / elapsed) * 60000).toFixed(0) : '0';

  const msg = `📊 Progress: ${current}/${config.endId} (${pct}%) | Orgs: ${orgsFound} | Errors: ${errorCount} | Speed: ${speed}/min`;
  console.log(msg);
  await sendTelegram(msg);
}

async function main() {
  // Determine effective start ID
  const checkpoint = readCheckpoint();
  const effectiveStart = checkpoint !== null ? checkpoint + 1 : config.startId;

  if (effectiveStart > config.endId) {
    console.log(`Range already completed (checkpoint: ${checkpoint}, end: ${config.endId}). Exiting.`);
    process.exit(0);
  }

  // IP leak check
  const { ip, country } = await checkIpLeak();
  let currentIp = ip;

  const startMsg = `🚀 Org Crawler started. Range: ${config.startId}–${config.endId}. Resuming from ${effectiveStart}. IP: ${ip} (${country})`;
  console.log(startMsg);
  await sendTelegram(startMsg);

  startTime = Date.now();

  // Main scan loop
  for (currentId = effectiveStart; currentId <= config.endId; currentId++) {
    if (shuttingDown) break;

    currentIp = await processId(currentId, currentIp);
    writeCheckpoint(currentId);

    // Progress summary every N IDs
    if ((currentId - config.startId) > 0 && (currentId - config.startId) % config.progressEveryN === 0) {
      await sendProgress(currentId);
    }

    await sleep(config.baseDelayMs);
  }

  // Completion
  const elapsed = formatDuration(Date.now() - startTime);
  const msg = `✅ Scan complete. Range: ${config.startId}–${config.endId}. Orgs found: ${orgsFound}. Failed IDs: ${errorCount}. Duration: ${elapsed}`;
  console.log(msg);
  await sendTelegram(msg);
}

// Graceful shutdown
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}. Finishing current request...`);

  // Give current request time to finish, then write checkpoint and exit
  setTimeout(async () => {
    if (currentId) {
      writeCheckpoint(currentId);
      const msg = `🛑 Crawler stopped gracefully at ID ${currentId}`;
      console.log(msg);
      await sendTelegram(msg);
    }
    process.exit(0);
  }, 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(async (err) => {
  const msg = `💀 Fatal error: ${err.message}`;
  console.error(msg);
  console.error(err.stack);
  await sendTelegram(msg);
  process.exit(1);
});
```

- [ ] **Step 2: Verify module loads (dry syntax check)**

Run: `START_ID=1 END_ID=100 node --check app.js`
Expected: No output (clean parse).

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add main crawler with backoff, VPN rotation, and graceful shutdown"
```

---

### Task 7: Docker & Deployment Files

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `release.sh`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY app.js .
COPY lib/ ./lib/

CMD ["node", "app.js"]
```

- [ ] **Step 2: Create docker-compose.yml**

```yaml
services:
  crawler:
    image: registry.yurii.live/org-crawler:latest
    container_name: org-crawler
    restart: unless-stopped
    environment:
      - START_ID=${START_ID}
      - END_ID=${END_ID}
      - BOT_TOKEN=${BOT_TOKEN}
      - CHAT_ID=${CHAT_ID}
      - TOPIC_ID=${TOPIC_ID}
      - BASE_DELAY_MS=${BASE_DELAY_MS:-100}
    volumes:
      - ./data:/app/data
    depends_on:
      gluetun:
        condition: service_healthy
    network_mode: "service:gluetun"

  gluetun:
    image: qmcgaw/gluetun
    container_name: gluetun-org-crawler
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    env_file: .env
    environment:
      - VPN_DNS=1.1.1.1,8.8.8.8
      - DNS_ADDRESS=1.1.1.1
      - HTTP_CONTROL_SERVER_ADDRESS=:8000
    volumes:
      - ./gluetun:/gluetun
    restart: unless-stopped
```

- [ ] **Step 3: Create release.sh**

```bash
#!/bin/bash
set -e

REGISTRY="${REGISTRY_URL:-registry.yurii.live}"
IMAGE_NAME="org-crawler"
TAG="${1:-latest}"

# Create and use buildx builder if not exists
docker buildx inspect multiarch >/dev/null 2>&1 || \
    docker buildx create --name multiarch --use

# Login to registry
if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_PASSWORD" ]; then
    echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
fi

# Build and push for both architectures
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "$REGISTRY/$IMAGE_NAME:$TAG" \
    --tag "$REGISTRY/$IMAGE_NAME:latest" \
    --push \
    .

echo "Pushed $REGISTRY/$IMAGE_NAME:$TAG"
```

- [ ] **Step 4: Make release.sh executable**

Run: `chmod +x release.sh`

- [ ] **Step 5: Verify Docker build**

Run: `docker build -t org-crawler:test .`
Expected: Successful build with no errors.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml release.sh
git commit -m "feat: add Dockerfile, docker-compose, and release script"
```

---

### Task 8: Local Smoke Test (Without VPN)

- [ ] **Step 1: Create data directory**

Run: `mkdir -p data`

- [ ] **Step 2: Run against a known org ID (1442329) to verify the full pipeline**

Run:
```bash
START_ID=1442329 END_ID=1442329 node app.js
```

Expected output (approximate):
```
[vpn] Current IP: <your-ip> (<your-country>)
🚀 Org Crawler started. Range: 1442329–1442329. Resuming from 1442329. IP: ...
🏢 Found org: <name> (ID: 1442329, <country>)
✅ Scan complete. Range: 1442329–1442329. Orgs found: 1. Failed IDs: 0. Duration: 0m
```

- [ ] **Step 3: Verify output files**

Run:
```bash
cat data/orgs.csv
cat data/checkpoint.txt
```

Expected: orgs.csv has header + 1 row, checkpoint.txt contains `1442329`.

- [ ] **Step 4: Test resumability — run again with same range**

Run: `START_ID=1442329 END_ID=1442329 node app.js`
Expected: `Range already completed (checkpoint: 1442329, end: 1442329). Exiting.`

- [ ] **Step 5: Clean up test data**

Run: `rm -rf data/`

- [ ] **Step 6: Commit (no changes expected — just verification)**

No commit needed. All code is already committed.

---

### Task 9: Build & Push Image

- [ ] **Step 1: Build and push to registry**

Run: `./release.sh`
Expected: Multi-arch build completes, image pushed to `registry.yurii.live/org-crawler:latest`.

- [ ] **Step 2: Verify image is in registry**

Run: `docker manifest inspect registry.yurii.live/org-crawler:latest`
Expected: Manifest with linux/amd64 and linux/arm64 platforms.
