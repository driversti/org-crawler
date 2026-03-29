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

  if (shuttingDown) {
    await onShutdownComplete();
    return;
  }

  // Completion
  const elapsed = formatDuration(Date.now() - startTime);
  const msg = `✅ Scan complete. Range: ${config.startId}–${config.endId}. Orgs found: ${orgsFound}. Failed IDs: ${errorCount}. Duration: ${elapsed}`;
  console.log(msg);
  await sendTelegram(msg);
}

// Graceful shutdown
let shutdownResolve;
const shutdownPromise = new Promise((resolve) => { shutdownResolve = resolve; });

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}. Finishing current request...`);
  // main loop checks shuttingDown and will call shutdownResolve when done
}

async function onShutdownComplete() {
  if (currentId) {
    writeCheckpoint(currentId);
    const msg = `🛑 Crawler stopped gracefully at ID ${currentId}`;
    console.log(msg);
    await sendTelegram(msg);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch(async (err) => {
  const msg = `💀 Fatal error: ${err.message}. Exiting.`;
  console.error(msg);
  console.error(err.stack);
  await sendTelegram(msg);
  process.exit(1);
});
