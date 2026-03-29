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
