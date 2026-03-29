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
