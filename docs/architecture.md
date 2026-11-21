# Org Crawler architecture

Stack: Node.js 20 (ESM), got-scraping, csv-writer, Docker, Gluetun + Surfshark WireGuard.

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

## Configuration (env vars, `.env`; see `.env.example`)

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

## How it works

1. **Startup:** validate env vars, read checkpoint, IP leak check (abort if Poland), send Telegram startup message.
2. **Scan loop:** for each ID fetch `citizen-profile-json-global/{id}`; if org, append to CSV + notify Telegram; write checkpoint; sleep.
3. **Error handling:** 404 is skipped silently. Retryable errors use exponential backoff (1, 2, 4, 8, 16s with +-30% jitter), then VPN rotation via the Gluetun API, then retry. After 3 VPN rotations the ID is logged to `failed.csv` and skipped.
4. **VPN rotation:** stop/start WireGuard via `localhost:8000/v1/vpn/status`, poll until connected, verify new IP via ipinfo.io.
5. **Progress:** Telegram summary every 10,000 IDs.
6. **Shutdown:** SIGTERM/SIGINT finishes the current request, writes the checkpoint, notifies Telegram, exits.

## API endpoint

`GET https://www.erepublik.com/en/main/citizen-profile-json-global/{citizenId}`

No authentication. Org detection: `response.citizen.is_organization === true`. `got-scraping` handles TLS fingerprint rotation.

## Telegram notifications

Sent to topic `TOPIC_ID` in supergroup `CHAT_ID`: startup (IP, range, resume point), org found, VPN rotated (old -> new IP), VPN reconnect failure, progress every 10K IDs, scan complete, IP leak detected, fatal error.

## Related

- v1 (stopped): `ubuntu@192.168.10.12:~/docker/org-crawler/`, data preserved (organizations.csv, progress.csv at ID ~1.5M).
- Spec: [SPEC.md](../SPEC.md). Plan: `docs/superpowers/plans/2026-03-29-org-crawler.md`.
- eRepublik API docs: `~/KnowledgeBase/Erepublik/API/`.
