# Org Crawler v2 — Specification

## Overview

A Node.js script that iterates over eRepublik citizen IDs, identifies organization accounts, and collects their data to a CSV file. Runs behind a Gluetun VPN container with automatic IP rotation on Cloudflare blocks.

**Replaces:** existing crawler at `ubuntu@192.168.10.12:/home/ubuntu/docker/org-crawler/`

## Goals

- Scan a configurable range of citizen IDs via the public API
- Collect org ID, name, created_at, and citizenship country
- Handle 404s silently, retry on errors, rotate VPN on Cloudflare blocks
- Resume from checkpoint on container restart
- Send significant events to a Telegram topic

---

## Architecture

### Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 18+ (Alpine) | Matches existing crawler |
| HTTP client | `got-scraping` | Built-in TLS fingerprint rotation, anti-bot header ordering |
| CSV writing | `csv-writer` | Append mode, proven in existing crawler |
| Container | Docker, `network_mode: service:gluetun` | All traffic through VPN |
| VPN | Gluetun + Surfshark | IP rotation via Gluetun HTTP API |

### File Structure

```
org-crawler/
├── app.js                  # Main crawler script
├── package.json
├── Dockerfile
├── docker-compose.yml      # Uses pre-built image from registry
├── release.sh              # Build + push image to registry.yurii.live
├── .env.example            # Template for env vars
├── .gitignore
└── data/                   # Mounted volume (gitignored)
    ├── orgs.csv            # Output: org data
    ├── failed.csv          # IDs that failed after all retries
    └── checkpoint.txt      # Single line: last processed ID
```

---

## Configuration (Environment Variables)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `START_ID` | Yes | — | First citizen ID to scan |
| `END_ID` | Yes | — | Last citizen ID to scan (inclusive) |
| `BOT_TOKEN` | No | — | Telegram bot token for notifications |
| `CHAT_ID` | No | — | Telegram chat ID (supergroup) |
| `TOPIC_ID` | No | — | Telegram topic/thread ID within the group |
| `BASE_DELAY_MS` | No | `100` | Delay between requests (ms) |

Gluetun-specific env vars (VPN_SERVICE_PROVIDER, etc.) go in `.env` and are consumed by the gluetun service directly.

---

## API Endpoint

**URL:** `GET https://www.erepublik.com/en/main/citizen-profile-json-global/{citizenId}`

**No authentication required.** The `got-scraping` library handles TLS fingerprinting and header rotation automatically.

### Response Handling

| Condition | Detection | Action |
|-----------|-----------|--------|
| Valid citizen (not org) | `citizen.is_organization === false` | Skip, update checkpoint |
| Valid org | `citizen.is_organization === true` | Append to orgs.csv, update checkpoint, notify Telegram |
| 404 | HTTP 404 status | Skip silently, update checkpoint |
| 403 / 429 | HTTP status | Enter backoff sequence |
| 5xx | HTTP 500-599 | Enter backoff sequence |
| Cloudflare challenge | Response is HTML (not JSON), or contains Cloudflare markers | Enter backoff sequence |
| Network error | Connection refused, timeout, DNS failure | Enter backoff sequence |

### Org Data Extraction

From a successful response where `citizen.is_organization === true`:

```json
{
  "id": "citizen.id",
  "name": "citizen.name",
  "created_at": "citizen.created_at",
  "country": "location.citizenshipCountry.name"
}
```

---

## Error Handling & Backoff Strategy

### Exponential Backoff with VPN Rotation

On any retryable error (403, 429, 5xx, Cloudflare, network error):

1. **Retry 1:** Wait 1s (±30% jitter)
2. **Retry 2:** Wait 2s (±30% jitter)
3. **Retry 3:** Wait 4s (±30% jitter)
4. **Retry 4:** Wait 8s (±30% jitter)
5. **Retry 5:** Wait 16s (±30% jitter)
6. **VPN Rotation:** Trigger Gluetun reconnect, poll until connected, verify new IP
7. **Post-rotation retries:** Reset backoff, retry the same ID from step 1
8. **If 3 consecutive VPN rotations fail for the same ID:** Log to failed.csv, notify Telegram, skip to next ID

### VPN Rotation Procedure

1. `PUT http://localhost:8000/v1/openvpn/status` with `{"status": "stopped"}`
2. Wait 2s
3. `PUT http://localhost:8000/v1/openvpn/status` with `{"status": "running"}`
4. Poll `GET http://localhost:8000/v1/openvpn/status` every 2s until `status === "running"`
5. Timeout after 30s — if VPN doesn't connect, retry rotation (max 3 attempts)
6. After connection, verify IP via `https://api.ipify.org?format=json`

### VPN Reconnect Failure (All 3 Rotation Attempts Fail)

If Gluetun cannot reconnect after 3 attempts:
1. Log error to stdout
2. Send Telegram notification: "VPN reconnect failed 3 times. Sleeping 5 minutes before retrying."
3. Sleep 5 minutes
4. Retry VPN rotation from scratch
5. Repeat indefinitely — the script never exits on VPN failure (designed for unattended operation)

This ensures the crawler survives temporary Surfshark outages without manual intervention.

**Note:** When VPN is down, Telegram sends will also fail (shared network stack). In this state, errors are logged to stdout only. Telegram notifications resume automatically once VPN reconnects.

---

## IP Leak Protection

On startup, before any eRepublik requests:
1. Fetch current IP from `https://api.ipify.org?format=json`
2. Geolocate via `http://ip-api.com/json/{ip}`
3. If country === "Poland" → log error, send Telegram alert, **exit with code 1**

This prevents accidental scanning from the real IP if Gluetun isn't routing traffic.

---

## Output Files

### orgs.csv

Append-only CSV with header row (created on first write):

```csv
ID,Name,Created At,Country
1442329,Some Org,2009-01-15,Romania
```

### failed.csv

Append-only CSV for IDs that failed after all retries (backoff + VPN rotation exhausted):

```csv
ID,Error,Timestamp
1500123,Cloudflare block after 3 VPN rotations,2026-03-29T15:30:00.000Z
```

**Does NOT include 404s** — those are expected gaps, not failures.

### checkpoint.txt

Single line containing the last successfully processed citizen ID:

```
1546378
```

Written after every ID is processed (success, 404, or logged to failed.csv). On startup, if this file exists, scanning resumes from `checkpoint + 1`. If the file doesn't exist, scanning starts from `START_ID`.

---

## Telegram Notifications

Messages are sent to `CHAT_ID` with `message_thread_id: TOPIC_ID` (forum topic).

### Significant Events (sent to Telegram)

| Event | Message Format |
|-------|---------------|
| Startup | `🚀 Org Crawler started. Range: {START_ID}–{END_ID}. Resuming from {checkpoint}. IP: {ip} ({country})` |
| Org found | `🏢 Found org: {name} (ID: {id}, {country})` |
| VPN rotation | `🔄 VPN rotated: {old_ip} → {new_ip}` |
| VPN failure (sleeping) | `⚠️ VPN reconnect failed 3x. Sleeping 5min.` |
| Progress summary | `📊 Progress: {current}/{end} ({pct}%) \| Orgs: {count} \| Errors: {errCount} \| Speed: {ids/min}/min` |
| Completion | `✅ Scan complete. Range: {START_ID}–{END_ID}. Orgs found: {count}. Failed IDs: {failCount}. Duration: {time}` |
| IP leak detected | `🚨 IP LEAK: detected Poland IP. Exiting immediately.` |
| Fatal error | `💀 Fatal error: {message}. Exiting.` |

### Progress Summary Frequency

Every **10,000 IDs** processed — provides pace and ETA without spamming.

### Events NOT sent to Telegram

- Individual 404s (expected — millions of them)
- Successful non-org profiles
- Individual backoff steps (only the VPN rotation result)

---

## Docker Setup

### Dockerfile

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY app.js .
CMD ["node", "app.js"]
```

### release.sh

Builds a multi-arch image and pushes to the private registry (same pattern as `battles-bot`, `erep-manager`, `euberbot`):

```bash
#!/bin/bash
set -e
IMAGE="registry.yurii.live/org-crawler"
TAG="${1:-latest}"
docker buildx build --platform linux/amd64,linux/arm64 -t "$IMAGE:$TAG" --push .
echo "Pushed $IMAGE:$TAG"
```

### docker-compose.yml

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

### .env.example

```env
# Crawler
START_ID=1
END_ID=13000000
BASE_DELAY_MS=100

# Telegram
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

---

## Request Pacing

- **Base delay:** `BASE_DELAY_MS` (default 100ms) between successful requests
- **Jitter on backoff:** Each backoff step has ±30% random jitter
- **Post-VPN-rotation:** Resume with base delay (backoff resets)
- **got-scraping handles:** TLS fingerprint rotation, header ordering, browser-like behavior per request

---

## Startup Sequence

1. Validate required env vars (`START_ID`, `END_ID`)
2. Read `data/checkpoint.txt` — if exists, override start to `checkpoint + 1`
3. If effective start > `END_ID` → log "range already completed", exit 0
4. IP leak check (ipify → ip-api.com → abort if Poland)
5. Send Telegram startup message
6. Begin scanning loop

---

## Graceful Shutdown

On `SIGTERM` / `SIGINT`:
1. Stop processing new IDs
2. Wait for current request to complete (if any)
3. Write final checkpoint
4. Send Telegram message: "Crawler stopped gracefully at ID {id}"
5. Exit 0

---

## Key Differences from Existing Crawler

| Aspect | Old (v1) | New (v2) |
|--------|----------|----------|
| Endpoint | `citizen-profile-json-personal` | `citizen-profile-json-global` |
| Auth | Hardcoded session cookies | None (public endpoint) |
| User-Agent | Manual 70+ UA array | `got-scraping` auto-rotation |
| CF mitigation | Exit on detection | Exponential backoff → VPN rotation |
| VPN rotation | None | Gluetun API (`localhost:8000`) |
| Progress | CSV (overwrites) | Plain text checkpoint file |
| Failed tracking | None | `failed.csv` with error reason |
| Telegram | Every org + errors to flat chat | Significant events to topic thread |
| IP leak check | Check on startup, exit if Poland | Same |
| Profile URL | Bug: double `//www.erepublik.com` | Fixed |
| Base delay | 2000ms fixed | 100ms configurable |
| Output fields | ID, name, created_at, profile_url | ID, name, created_at, country |
| Range | Infinite (no end) | Configurable START_ID / END_ID |
