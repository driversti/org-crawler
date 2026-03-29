# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Org Crawler v2 scans eRepublik citizen IDs sequentially, identifies organization accounts via the public API, and saves them to CSV. Runs behind a Gluetun VPN (Surfshark WireGuard) with automatic IP rotation on Cloudflare blocks.

**Replaces:** v1 at `ubuntu@192.168.10.12:~/docker/org-crawler/` (stopped, data preserved)

## Deployment

- **Server:** `ubuntu@192.168.10.12` (bravo, Raspberry Pi)
- **Path:** `~/docker/org-crawler-v2/`
- **Registry:** `registry.yurii.live/org-crawler:latest`
- **FileBrowser:** http://192.168.10.12:8082 (admin access to bravo's home dir)

## Commands

```bash
# Build and push image (run locally)
./release.sh

# Deploy on bravo (after push)
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose pull crawler && docker compose up -d"

# View logs
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose logs crawler --tail 50"

# Check status
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose ps"

# Stop
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose stop crawler"

# Reset checkpoint (start from scratch)
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose stop crawler && docker run --rm -v ./data:/data alpine rm /data/checkpoint.txt && docker compose start crawler"
```

## Architecture

**Stack:** Node.js 20, got-scraping, csv-writer, Docker, Gluetun + Surfshark WireGuard

```
org-crawler/
├── app.js                  # Entry point: startup, scan loop, graceful shutdown
├── lib/
│   ├── config.js           # Env var parsing and validation
│   ├── telegram.js         # Telegram topic notifications (silent on failure)
│   ├── csv-io.js           # Checkpoint, orgs.csv, failed.csv writers
│   └── vpn.js              # IP leak check, Gluetun API rotation
├── Dockerfile              # Node 20 Alpine
├── docker-compose.yml      # Crawler + Gluetun services
├── release.sh              # Multi-arch build + push to registry
└── data/                   # Mounted volume (on server)
    ├── orgs.csv            # Output: ID, Name, Created At, Country
    ├── failed.csv          # IDs that failed after all retries
    └── checkpoint.txt      # Last processed ID (single integer)
```

## Configuration

All via environment variables in `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `START_ID` | Yes | First citizen ID to scan |
| `END_ID` | Yes | Last citizen ID to scan (inclusive) |
| `BASE_DELAY_MS` | No (100) | Delay between requests in ms |
| `BOT_TOKEN` | No | Telegram bot token |
| `CHAT_ID` | No | Telegram supergroup ID |
| `TOPIC_ID` | No | Telegram topic/thread ID |
| `WIREGUARD_PRIVATE_KEY` | Yes | Surfshark WireGuard private key |
| `WIREGUARD_ADDRESSES` | Yes | Tunnel interface address (e.g., 10.14.0.2/16) |
| `SERVER_COUNTRIES` | No (Germany) | Surfshark server country |

## How It Works

1. **Startup:** Validate env vars → read checkpoint → IP leak check (abort if Poland) → send Telegram startup message
2. **Scan loop:** For each ID: fetch `citizen-profile-json-global/{id}` → if org, append to CSV + notify Telegram → write checkpoint → sleep
3. **Error handling:** 404 → skip silently. Retryable errors → exponential backoff (1→2→4→8→16s with ±30% jitter) → VPN rotation via Gluetun API → retry. After 3 VPN rotations → log to failed.csv, skip.
4. **VPN rotation:** Stop/start WireGuard via `localhost:8000/v1/vpn/status` → poll until connected → verify new IP via ipinfo.io
5. **Progress:** Telegram summary every 10,000 IDs
6. **Shutdown:** SIGTERM/SIGINT → finish current request → write checkpoint → notify Telegram → exit

## API Endpoint

`GET https://www.erepublik.com/en/main/citizen-profile-json-global/{citizenId}`

No authentication required. Org detection: `response.citizen.is_organization === true`. The `got-scraping` library handles TLS fingerprint rotation automatically.

## Telegram Notifications

Sent to topic `TOPIC_ID` in supergroup `CHAT_ID`:
- 🚀 Startup (IP, range, resume point)
- 🏢 Org found (name, ID, country)
- 🔄 VPN rotated (old → new IP)
- ⚠️ VPN reconnect failure
- 📊 Progress every 10K IDs
- ✅ Scan complete
- 🚨 IP leak detected
- 💀 Fatal error

## Known Issues / Gotchas

- **Gluetun DNS blocks `ip-api.com`** — uses `ipinfo.io` instead (returns 2-letter country codes)
- **DNS not ready on startup** — IP leak check retries 5 times with 5s delay
- **Gluetun healthcheck** — uses `google.com` (not `ifconfig.me`, which is unreachable through Gluetun)
- **Data dir permissions** — files created by the container are owned by root; use `docker run --rm -v ./data:/data alpine ...` to modify them from the host
- **LXC containers can't run VPN** — must use a VM or bare metal (bravo is bare metal Raspberry Pi)

## Related

- **v1 (stopped):** `ubuntu@192.168.10.12:~/docker/org-crawler/` — data preserved (organizations.csv, progress.csv at ID ~1.5M)
- **Spec:** `SPEC.md` in this repo
- **Plan:** `docs/superpowers/plans/2026-03-29-org-crawler.md`
- **eRepublik API docs:** `/Users/driversti/KnowledgeBase/Erepublik/API/`
