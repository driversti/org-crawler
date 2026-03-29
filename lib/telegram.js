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
