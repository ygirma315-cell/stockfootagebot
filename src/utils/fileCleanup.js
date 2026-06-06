const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');

function ensureInsideDownloads(filePath) {
  const resolved = path.resolve(filePath);
  const downloadsRoot = path.resolve(config.downloadsDir);

  if (resolved !== downloadsRoot && !resolved.startsWith(`${downloadsRoot}${path.sep}`)) {
    throw new Error('Refusing to access a file outside the downloads directory.');
  }

  return resolved;
}

async function ensureRuntimeDirs() {
  await fsp.mkdir(config.downloadsDir, { recursive: true });
  await fsp.mkdir(path.dirname(config.usageFilePath), { recursive: true });
}

function tempFilePath(prefix, extension) {
  const safePrefix = String(prefix || 'media').replace(/[^a-z0-9_-]/gi, '').slice(0, 32);
  const safeExtension = String(extension || '.bin')
    .replace(/[^a-z0-9.]/gi, '')
    .slice(0, 10);
  const normalizedExtension = safeExtension.startsWith('.')
    ? safeExtension
    : `.${safeExtension || 'bin'}`;
  const name = `${safePrefix || 'media'}-${crypto.randomUUID()}${normalizedExtension}`;

  return ensureInsideDownloads(path.join(config.downloadsDir, name));
}

async function cleanupFile(filePath) {
  if (!filePath) {
    return;
  }

  const safePath = ensureInsideDownloads(filePath);
  await fsp.rm(safePath, { force: true });
}

async function downloadFile(url, options = {}) {
  await ensureRuntimeDirs();

  const parsedUrl = new URL(url);
  const maxBytes = options.maxBytes || config.videoMaxBytes;
  const timeoutMs = options.timeoutMs || config.downloadTimeoutMs;
  const filePath = tempFilePath(options.prefix, options.extension);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let bytes = 0;

  try {
    const response = await fetch(parsedUrl, {
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Download failed with status ${response.status}.`);
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > maxBytes) {
      throw new Error('Download is larger than the configured safety limit.');
    }

    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          callback(new Error('Download exceeded the configured safety limit.'));
          return;
        }

        callback(null, chunk);
      }
    });

    await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(filePath));
    return filePath;
  } catch (error) {
    await cleanupFile(filePath).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function cleanupOldDownloads(maxAgeMs = 2 * 60 * 60 * 1000) {
  await ensureRuntimeDirs();

  const files = await fsp.readdir(config.downloadsDir, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
      .map(async (entry) => {
        const fullPath = ensureInsideDownloads(path.join(config.downloadsDir, entry.name));
        const stat = await fsp.stat(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await cleanupFile(fullPath);
        }
      })
  );
}

module.exports = {
  cleanupFile,
  cleanupOldDownloads,
  downloadFile,
  ensureRuntimeDirs,
  tempFilePath
};
