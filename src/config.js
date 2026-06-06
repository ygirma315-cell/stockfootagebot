const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

const aiApiKey = optionalString(process.env.AI_API_KEY);
const isNvidiaStyleKey = aiApiKey.startsWith('nvapi-');
const keepAliveUrl =
  optionalString(process.env.KEEP_ALIVE_URL) ||
  optionalString(process.env.RENDER_EXTERNAL_URL);
const keepAliveEnabledValue = optionalString(process.env.KEEP_ALIVE_ENABLED).toLowerCase();

module.exports = {
  rootDir,
  telegramBotToken: optionalString(process.env.TELEGRAM_BOT_TOKEN),
  pexelsApiKey: optionalString(process.env.PEXELS_API_KEY),
  aiApiKey,
  aiApiBaseUrl:
    optionalString(process.env.AI_API_BASE_URL) ||
    (isNvidiaStyleKey
      ? 'https://integrate.api.nvidia.com/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions'),
  aiModel:
    optionalString(process.env.AI_MODEL) ||
    (isNvidiaStyleKey ? 'meta/llama-3.1-70b-instruct' : 'gpt-4o-mini'),
  voiceoverApiKey: optionalString(process.env.VOICEOVER_API_KEY),
  voiceoverApiBaseUrl: optionalString(process.env.VOICEOVER_API_BASE_URL),
  voiceoverModel: optionalString(process.env.VOICEOVER_MODEL),
  ownerUsername: optionalString(process.env.OWNER_USERNAME),
  ownerUsernameNormalized: optionalString(process.env.OWNER_USERNAME)
    .replace(/^@/, '')
    .toLowerCase(),
  port: positiveInteger(process.env.PORT, 3000),
  keepAliveEnabled: Boolean(keepAliveUrl) && keepAliveEnabledValue !== 'false',
  keepAliveIntervalMinutes: positiveInteger(process.env.KEEP_ALIVE_INTERVAL_MINUTES, 10),
  keepAliveUrl,
  maxMediaPerRequest: positiveInteger(process.env.MAX_MEDIA_PER_REQUEST, 20),
  quotaTimezone: optionalString(process.env.QUOTA_TIMEZONE) || 'UTC',
  usageFilePath: path.join(rootDir, 'data', 'usage.json'),
  downloadsDir: path.join(rootDir, 'downloads'),
  imageMaxBytes: 12 * 1024 * 1024,
  videoMaxBytes: 50 * 1024 * 1024,
  downloadTimeoutMs: 45_000
};
