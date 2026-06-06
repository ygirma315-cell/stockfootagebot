const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { getPlan, isValidPlan, limitFor } = require('./plans');

async function ensureUsageFile() {
  await fsp.mkdir(path.dirname(config.usageFilePath), { recursive: true });

  try {
    await fsp.access(config.usageFilePath);
  } catch {
    await fsp.writeFile(config.usageFilePath, JSON.stringify({ users: {} }, null, 2));
  }
}

function todayKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.quotaTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }
}

async function readUsage() {
  await ensureUsageFile();
  const raw = await fsp.readFile(config.usageFilePath, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.users
      ? parsed
      : { users: {} };
  } catch {
    return { users: {} };
  }
}

async function writeUsage(usage) {
  await ensureUsageFile();
  const tempPath = `${config.usageFilePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(usage, null, 2));
  await fsp.rename(tempPath, config.usageFilePath);
}

function emptyBalances() {
  return {
    birr: 0,
    usdt: 0
  };
}

function normalizeBalances(balances) {
  return {
    ...emptyBalances(),
    ...(balances && typeof balances === 'object' ? balances : {})
  };
}

function normalizeEntry(user, existingEntry = {}) {
  const date = todayKey();
  const migratedRequests = Number(existingEntry.requestsToday || 0);
  const entry = {
    telegramUserId: user.id,
    username: user.username || '',
    plan: 'free',
    imageRequestsToday: 0,
    videoRequestsToday: 0,
    requestsToday: 0,
    totalRequests: 0,
    lastRequestDate: date,
    balances: emptyBalances(),
    ...existingEntry
  };

  entry.telegramUserId = user.id;
  entry.username = user.username || entry.username || '';
  entry.plan = isValidPlan(entry.plan) ? entry.plan : 'free';
  entry.balances = normalizeBalances(entry.balances);

  if (entry.lastRequestDate !== date) {
    entry.imageRequestsToday = 0;
    entry.videoRequestsToday = 0;
    entry.requestsToday = 0;
    entry.lastRequestDate = date;
  } else if (
    migratedRequests > 0 &&
    !Number(entry.imageRequestsToday) &&
    !Number(entry.videoRequestsToday)
  ) {
    entry.imageRequestsToday = migratedRequests;
    entry.requestsToday = migratedRequests;
  }

  entry.imageRequestsToday = Number(entry.imageRequestsToday || 0);
  entry.videoRequestsToday = Number(entry.videoRequestsToday || 0);
  entry.requestsToday = Number(entry.requestsToday || 0);
  entry.totalRequests = Number(entry.totalRequests || 0);

  return entry;
}

function counterName(mediaType) {
  return mediaType === 'image' ? 'imageRequestsToday' : 'videoRequestsToday';
}

async function checkAndIncrement(user, options = {}) {
  const mediaType = options.mediaType === 'image' ? 'image' : 'video';
  const usage = await readUsage();
  const userId = String(user.id);
  const entry = normalizeEntry(user, usage.users[userId]);
  const counter = counterName(mediaType);
  const limit = options.isOwner ? Number.POSITIVE_INFINITY : limitFor(entry.plan, mediaType);

  if (entry[counter] >= limit) {
    usage.users[userId] = entry;
    await writeUsage(usage);
    return {
      allowed: false,
      entry,
      limit,
      mediaType,
      plan: getPlan(entry.plan),
      remaining: 0,
      unlimited: !Number.isFinite(limit)
    };
  }

  entry[counter] += 1;
  entry.requestsToday += 1;
  entry.totalRequests += 1;
  usage.users[userId] = entry;
  await writeUsage(usage);

  return {
    allowed: true,
    entry,
    limit,
    mediaType,
    plan: getPlan(entry.plan),
    remaining: Number.isFinite(limit) ? Math.max(0, limit - entry[counter]) : null,
    unlimited: !Number.isFinite(limit)
  };
}

async function profile(user) {
  const usage = await readUsage();
  const userId = String(user.id);
  const entry = normalizeEntry(user, usage.users[userId]);
  usage.users[userId] = entry;
  await writeUsage(usage);

  return {
    entry,
    plan: getPlan(entry.plan)
  };
}

async function resetUser(userId) {
  const usage = await readUsage();
  const key = String(userId);

  if (!usage.users[key]) {
    return false;
  }

  usage.users[key].imageRequestsToday = 0;
  usage.users[key].videoRequestsToday = 0;
  usage.users[key].requestsToday = 0;
  usage.users[key].lastRequestDate = todayKey();
  await writeUsage(usage);
  return true;
}

async function setPlan(userId, planId) {
  const normalizedPlan = String(planId || '').toLowerCase();

  if (!isValidPlan(normalizedPlan)) {
    return null;
  }

  const usage = await readUsage();
  const key = String(userId);
  const entry = normalizeEntry({ id: key, username: '' }, usage.users[key]);
  entry.plan = normalizedPlan;
  usage.users[key] = entry;
  await writeUsage(usage);
  return entry;
}

async function addBalance(userId, amount, currency) {
  const normalizedCurrency = String(currency || '').toLowerCase();

  if (!['birr', 'usdt'].includes(normalizedCurrency)) {
    return null;
  }

  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return null;
  }

  const usage = await readUsage();
  const key = String(userId);
  const entry = normalizeEntry({ id: key, username: '' }, usage.users[key]);
  entry.balances[normalizedCurrency] =
    Number(entry.balances[normalizedCurrency] || 0) + parsedAmount;
  usage.users[key] = entry;
  await writeUsage(usage);
  return entry;
}

async function stats() {
  const usage = await readUsage();
  const users = Object.values(usage.users);
  const today = todayKey();
  const totalUsers = users.length;
  const totalRequests = users.reduce((sum, user) => sum + Number(user.totalRequests || 0), 0);
  const requestsToday = users
    .filter((user) => user.lastRequestDate === today)
    .reduce((sum, user) => sum + Number(user.requestsToday || 0), 0);
  const plans = users.reduce((counts, user) => {
    const planId = isValidPlan(user.plan) ? user.plan : 'free';
    counts[planId] = (counts[planId] || 0) + 1;
    return counts;
  }, {});

  return {
    today,
    totalUsers,
    totalRequests,
    requestsToday,
    plans
  };
}

module.exports = {
  addBalance,
  checkAndIncrement,
  profile,
  resetUser,
  setPlan,
  stats
};
