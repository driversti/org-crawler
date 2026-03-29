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
  await gotScraping.put(`${config.gluetunApiUrl}/v1/vpn/status`, {
    json: { status },
    timeout: { request: 10000 },
  });
}

async function getVpnStatus() {
  const response = await gotScraping.get(`${config.gluetunApiUrl}/v1/vpn/status`, {
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
