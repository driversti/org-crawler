# Org Crawler

Single source of truth for every coding agent: `AGENTS.md` and `GEMINI.md` are symlinks to this file.

Org Crawler v2 scans eRepublik citizen IDs sequentially via the public API, finds organization accounts and saves them to CSV. Runs behind a Gluetun VPN (Surfshark WireGuard) and rotates the IP on Cloudflare blocks. Replaces v1 (stopped, data preserved).

How it works (scan loop, retries, VPN rotation, env vars, Telegram events, data files): [docs/architecture.md](docs/architecture.md). Original design: [SPEC.md](SPEC.md).

## Build & test

```bash
npm install
npm start            # node app.js (needs .env: START_ID, END_ID; real runs need the Gluetun VPN)
```

No test suite or build step (plain ESM JavaScript, Node 20). Config comes from `.env` (copy `.env.example`); never commit it.

## Release & deploy

Target: `ubuntu@192.168.10.12` (hostname bravo, bare-metal Raspberry Pi), stack in `~/docker/org-crawler-v2/`. Image `registry.yurii.live/org-crawler:latest` (multi-arch amd64+arm64).

```bash
./release.sh         # buildx build + push (optional arg = extra tag; REGISTRY_USER/REGISTRY_PASSWORD env to log in)
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose pull crawler && docker compose up -d"
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose logs crawler --tail 50"
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose ps"
```

Reset checkpoint (restarts the scan from scratch, destructive, ask first):

```bash
ssh ubuntu@192.168.10.12 "cd ~/docker/org-crawler-v2 && docker compose stop crawler && docker run --rm -v ./data:/data alpine rm /data/checkpoint.txt && docker compose start crawler"
```

FileBrowser for bravo's home dir: http://192.168.10.12:8082.

## Gotchas

- Must run on a VM or bare metal: LXC containers cannot run the VPN.
- Gluetun DNS blocks `ip-api.com`; the IP check uses `ipinfo.io` (2-letter country codes). Gluetun healthcheck uses `google.com` (`ifconfig.me` is unreachable through it).
- Startup aborts if the detected IP is in Poland (leak guard); DNS may not be ready, so the check retries 5 times with 5s delay.
- Files in `data/` are created by the container as root; modify them with `docker run --rm -v ./data:/data alpine ...`.
- The crawler shares Gluetun's network (`network_mode: service:gluetun`); do not give it its own network or it bypasses the VPN.
- Never write `BOT_TOKEN` or `WIREGUARD_PRIVATE_KEY` into files or docs.
