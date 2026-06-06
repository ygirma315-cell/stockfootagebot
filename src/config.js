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

function optionalStringList(...values) {
  return values
    .flatMap((value) => optionalString(value).split(/[,\s]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

const aiApiKey = optionalString(process.env.AI_API_KEY);
const isNvidiaStyleKey = aiApiKey.startsWith('nvapi-');
const renderExternalUrl = optionalString(process.env.RENDER_EXTERNAL_URL);
const keepAliveUrl =
  optionalString(process.env.KEEP_ALIVE_URL) ||
  renderExternalUrl;
const keepAliveEnabledValue = optionalString(process.env.KEEP_ALIVE_ENABLED).toLowerCase();
const webhookPath = optionalString(process.env.WEBHOOK_PATH) || '/telegram-webhook';
const webhookUrl =
  optionalString(process.env.WEBHOOK_URL) ||
  (renderExternalUrl ? `${renderExternalUrl.replace(/\/$/, '')}${webhookPath}` : '');
const webhookEnabledValue = optionalString(process.env.WEBHOOK_ENABLED).toLowerCase();

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
  ownerTelegramIds: optionalStringList(
    process.env.OWNER_TELEGRAM_ID,
    process.env.OWNER_TELEGRAM_IDS
  ),
  port: positiveInteger(process.env.PORT, 3000),
  keepAliveEnabled: Boolean(keepAliveUrl) && keepAliveEnabledValue !== 'false',
  keepAliveIntervalMinutes: positiveInteger(process.env.KEEP_ALIVE_INTERVAL_MINUTES, 10),
  keepAliveUrl,
  webhookEnabled: Boolean(webhookUrl) && webhookEnabledValue !== 'false',
  webhookPath,
  webhookSecretToken: optionalString(process.env.WEBHOOK_SECRET_TOKEN),
  webhookUrl,
  maxMediaPerRequest: positiveInteger(process.env.MAX_MEDIA_PER_REQUEST, 20),
  quotaTimezone: optionalString(process.env.QUOTA_TIMEZONE) || 'UTC',
  usageFilePath: path.join(rootDir, 'data', 'usage.json'),
  downloadsDir: path.join(rootDir, 'downloads'),
  imageMaxBytes: 12 * 1024 * 1024,
  videoMaxBytes: positiveInteger(process.env.VIDEO_MAX_MB, 18) * 1024 * 1024,
  downloadTimeoutMs: positiveInteger(process.env.DOWNLOAD_TIMEOUT_MS, 20_000)
};
