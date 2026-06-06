const http = require('http');
const { Telegraf } = require('telegraf');
const config = require('./config');
const logger = require('./utils/logger');
const { cleanupFile, cleanupOldDownloads, ensureRuntimeDirs } = require('./utils/fileCleanup');
const { generateScriptWithAi } = require('./services/aiService');
const { analyzeScript } = require('./services/scriptAnalyzer');
const { renderPremiumVideo } = require('./services/renderService');
const {
  downloadImage,
  downloadVideo,
  searchInlineVideos,
  searchImages,
  searchVideos
} = require('./services/pexelsService');
const quotaService = require('./services/quotaService');
const telegram = require('./services/telegramService');
const {
  buildSearchQuery,
  normalizeWhitespace,
  sanitizePrompt,
  wordCount
} = require('./utils/textTools');

const userSessions = new Map();
const inlineVideoCache = new Map();
const INLINE_CACHE_TTL_MS = 90_000;
const INLINE_DEFAULT_QUERY = 'cinematic nature';
const INLINE_MIN_SEARCH_CHARS = 2;
const INLINE_SEARCH_TIMEOUT_MS = 2000;
const premiumRenderQueue = [];
let activePremiumRenders = 0;

function validateConfig() {
  const missing = [];

  if (!config.telegramBotToken) {
    missing.push('TELEGRAM_BOT_TOKEN');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function normalizeUsername(username) {
  return String(username || '').replace(/^@/, '').toLowerCase();
}

function isOwner(ctx) {
  const userId = String(ctx.from?.id || '');

  if (userId && config.ownerTelegramIds.includes(userId)) {
    return true;
  }

  return Boolean(
    config.ownerUsernameNormalized &&
      normalizeUsername(ctx.from?.username) === config.ownerUsernameNormalized
  );
}

async function sendStart(ctx) {
  await ctx.reply(telegram.welcomeText(), telegram.mainMenuKeyboard());
}

async function configureBotMenu(bot) {
  const userCommands = [
    { command: 'menu', description: 'Open the main buttons' },
    { command: 'images', description: 'Create stock photos' },
    { command: 'videos', description: 'Create stock videos' },
    { command: 'script', description: 'Generate a video script' },
    { command: 'subscription', description: 'View subscription plans' },
    { command: 'balance', description: 'Check balance and top up' },
    { command: 'topup', description: 'Request a balance top-up' },
    { command: 'inline', description: 'How inline video search works' },
    { command: 'help', description: 'How to use the bot' },
    { command: 'cancel', description: 'Reset the current flow' }
  ];
  const ownerCommands = [
    ...userCommands,
    { command: 'stats', description: 'Owner: view usage stats' },
    { command: 'reset_user', description: 'Owner: reset a user quota' },
    { command: 'set_plan', description: 'Owner: activate a user plan' },
    { command: 'add_balance', description: 'Owner: credit user balance' }
  ];

  await bot.telegram.setMyCommands(userCommands);
  await bot.telegram.setMyCommands([], {
    scope: {
      type: 'all_group_chats'
    }
  });
  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: 'commands'
    }
  });

  for (const ownerId of config.ownerTelegramIds) {
    if (!/^\d+$/.test(ownerId)) {
      continue;
    }

    try {
      await bot.telegram.setMyCommands(ownerCommands, {
        scope: {
          type: 'chat',
          chat_id: Number(ownerId)
        }
      });
    } catch (error) {
      logger.warn('Owner command menu setup failed.', {
        ownerId,
        error: {
          name: error.name,
          message: error.message
        }
      });
    }
  }

  logger.info('Telegram command menu configured.');
}

function startHealthServer(bot) {
  const webhookCallback =
    bot && config.webhookEnabled
      ? bot.webhookCallback(config.webhookPath, {
          secretToken: config.webhookSecretToken
        })
      : null;

  const server = http.createServer((request, response) => {
    if (webhookCallback && request.method === 'POST' && request.url === config.webhookPath) {
      webhookCallback(request, response);
      return;
    }

    const isHealthRoute = request.url === '/' || request.url === '/health';

    response.writeHead(isHealthRoute ? 200 : 404, {
      'Content-Type': 'application/json'
    });
    response.end(
      JSON.stringify({
        ok: isHealthRoute,
        service: 'stock-footage-telegram-bot'
      })
    );
  });

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(`Health server listening on port ${config.port}.`);
  });

  return server;
}

async function startBotTransport(bot) {
  if (config.webhookEnabled) {
    await bot.telegram.setWebhook(config.webhookUrl, {
      allowed_updates: ['message', 'callback_query', 'inline_query'],
      secret_token: config.webhookSecretToken || undefined
    });
    logger.info(`Telegram webhook set to ${config.webhookUrl}.`);
    return 'webhook';
  }

  await bot.launch();
  logger.info('Telegram bot started with long polling.');
  return 'polling';
}

function startKeepAlivePinger() {
  if (!config.keepAliveEnabled) {
    return null;
  }

  const pingUrl = `${config.keepAliveUrl.replace(/\/$/, '')}/health`;
  const intervalMs = config.keepAliveIntervalMinutes * 60 * 1000;

  const ping = async () => {
    try {
      const response = await fetch(pingUrl, {
        headers: {
          'User-Agent': 'stock-footage-telegram-bot-keepalive'
        }
      });

      logger.info(`Keep-alive ping returned ${response.status}.`);
    } catch (error) {
      logger.warn('Keep-alive ping failed.', {
        error: {
          name: error.name,
          message: error.message
        }
      });
    }
  };

  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  setTimeout(ping, 30_000).unref?.();
  logger.info(`Keep-alive pinger enabled for ${pingUrl}.`);
  return timer;
}

async function userHasPremiumAccess(ctx) {
  if (isOwner(ctx)) {
    return true;
  }

  const profile = await quotaService.profile(ctx.from);
  return profile.plan.id === 'premium';
}

function defaultSession() {
  return {
    state: 'idle',
    mediaType: null,
    orientation: 'landscape',
    ratioLabel: '16:9',
    videoWorkflow: 'stock',
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  };
}

function getSession(ctx) {
  if (!ctx.from?.id) {
    return defaultSession();
  }

  return {
    ...defaultSession(),
    ...(userSessions.get(ctx.from.id) || {})
  };
}

function updateSession(ctx, updates) {
  if (!ctx.from?.id) {
    return;
  }

  userSessions.set(ctx.from.id, {
    ...getSession(ctx),
    ...updates
  });
}

function resetSession(ctx) {
  if (!ctx.from?.id) {
    return;
  }

  userSessions.set(ctx.from.id, defaultSession());
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === 'private';
}

async function privateChatOnly(ctx, next) {
  if (ctx.updateType === 'inline_query' || isPrivateChat(ctx)) {
    return next();
  }

  if (ctx.callbackQuery?.id) {
    await ctx.answerCbQuery('Open the bot privately. Inline search works in groups.').catch(() => {});
  }

  return undefined;
}

function ratioSettings(ratioLabel) {
  if (ratioLabel === '9:16') {
    return {
      ratioLabel: '9:16',
      orientation: 'portrait'
    };
  }

  return {
    ratioLabel: '16:9',
    orientation: 'landscape'
  };
}

async function handleOwnerStats(ctx) {
  if (!isOwner(ctx)) {
    await ctx.reply('Only the owner can use this command.');
    return;
  }

  const stats = await quotaService.stats();
  await ctx.reply(
    [
      `Date: ${stats.today}`,
      `Users: ${stats.totalUsers}`,
      `Requests today: ${stats.requestsToday}`,
      `Total requests: ${stats.totalRequests}`,
      `Free users: ${stats.plans.free || 0}`,
      `Golden users: ${stats.plans.golden || 0}`,
      `Platinum users: ${stats.plans.platinum || 0}`,
      `Premium users: ${stats.plans.premium || 0}`
    ].join('\n')
  );
}

async function handleResetUser(ctx) {
  if (!isOwner(ctx)) {
    await ctx.reply('Only the owner can use this command.');
    return;
  }

  const parts = String(ctx.message?.text || '').trim().split(/\s+/);
  const userId = parts[1];

  if (!/^\d+$/.test(userId || '')) {
    await ctx.reply('Usage: /reset_user <telegram_user_id>');
    return;
  }

  const reset = await quotaService.resetUser(userId);
  await ctx.reply(reset ? `Quota reset for ${userId}.` : `No usage record found for ${userId}.`);
}

async function handleSetPlan(ctx) {
  if (!isOwner(ctx)) {
    await ctx.reply('Only the owner can use this command.');
    return;
  }

  const parts = String(ctx.message?.text || '').trim().split(/\s+/);
  const userId = parts[1];
  const planId = parts[2];

  if (!/^\d+$/.test(userId || '') || !planId) {
    await ctx.reply('Usage: /set_plan <telegram_user_id> <free|golden|platinum|premium>');
    return;
  }

  const entry = await quotaService.setPlan(userId, planId);

  if (!entry) {
    await ctx.reply('Unknown plan. Use free, golden, platinum, or premium.');
    return;
  }

  await ctx.reply(telegram.planUpdatedText(entry));
}

async function handleAddBalance(ctx) {
  if (!isOwner(ctx)) {
    await ctx.reply('Only the owner can use this command.');
    return;
  }

  const parts = String(ctx.message?.text || '').trim().split(/\s+/);
  const userId = parts[1];
  const amount = parts[2];
  const currency = String(parts[3] || '').toLowerCase();

  if (!/^\d+$/.test(userId || '') || !amount || !['birr', 'usdt'].includes(currency)) {
    await ctx.reply('Usage: /add_balance <telegram_user_id> <amount> <birr|usdt>');
    return;
  }

  const entry = await quotaService.addBalance(userId, amount, currency);

  if (!entry) {
    await ctx.reply('Could not add balance. Check the amount and currency.');
    return;
  }

  await ctx.reply(telegram.balanceUpdatedText(entry, currency));
}

async function sendMediaForScene(ctx, scene, mediaType, options = {}) {
  let downloadedFile;
  const excludeIds = [...(options.excludeIds || [])];
  const maxAttempts = mediaType === 'video' ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let result;

    try {
      result =
        mediaType === 'image'
          ? await searchImages(scene.pexelsQuery, {
              orientation: options.orientation,
              excludeIds
            })
          : await searchVideos(scene.pexelsQuery, {
              orientation: options.orientation,
              excludeIds
            });
    } catch (error) {
      logger.warn('Media search skipped.', {
        mediaType,
        error: {
          name: error.name,
          message: error.message
        }
      });
      await ctx.reply('⚠️ I could not search that scene cleanly. Trying the next one.');
      return null;
    }

    if (!result) {
      await ctx.reply(telegram.noMediaText());
      return null;
    }

    try {
      const caption = telegram.sceneCaption(scene, mediaType, result, options.ratioLabel);

      if (mediaType === 'video') {
        await ctx.reply('Found footage. Sending it to Telegram now...');
        await ctx.replyWithVideo(result.downloadUrl, {
          caption,
          supports_streaming: true
        });
      } else {
        downloadedFile = await downloadImage(result);
        await ctx.replyWithPhoto({ source: downloadedFile }, { caption });
      }

      return result;
    } catch (error) {
      await cleanupFile(downloadedFile).catch(() => {});
      downloadedFile = null;
      excludeIds.push(result.id);

      if (mediaType === 'video' && result?.downloadUrl) {
        try {
          await ctx.reply('Telegram had trouble fetching that clip. Trying one safer upload...');
          downloadedFile = await downloadVideo(result);
          await ctx.replyWithVideo(
            { source: downloadedFile },
            {
              caption: telegram.sceneCaption(scene, mediaType, result, options.ratioLabel),
              supports_streaming: true
            }
          );
          return result;
        } catch (fallbackError) {
          await cleanupFile(downloadedFile).catch(() => {});
          downloadedFile = null;
          logger.warn('Video fallback upload failed.', {
            error: {
              name: fallbackError.name,
              message: fallbackError.message
            }
          });
        }
      }

      logger.warn('Media result skipped.', {
        mediaType,
        error: {
          name: error.name,
          message: error.message
        }
      });

      if (attempt === maxAttempts - 1) {
        await ctx.reply('⚠️ I could not send a clean match for this scene. Trying the next one.');
        return null;
      }
    } finally {
      await cleanupFile(downloadedFile).catch((error) => {
        logger.warn('Temporary media cleanup failed.', {
          error: {
            name: error.name,
            message: error.message
          }
        });
      });
      downloadedFile = null;
    }
  }

  return null;
}

async function sendVideoFromSession(ctx, videoSession) {
  if (!videoSession || videoSession.sentCount >= videoSession.maxResults) {
    return false;
  }

  const baseScene = videoSession.scenes[0];
  const scene =
    videoSession.nextSceneIndex < videoSession.scenes.length
      ? videoSession.scenes[videoSession.nextSceneIndex]
      : baseScene;

  videoSession.nextSceneIndex += 1;

  const result = await sendMediaForScene(
    ctx,
    {
      ...scene,
      sceneNumber: videoSession.sentCount + 1
    },
    'video',
    {
      orientation: videoSession.orientation,
      ratioLabel: videoSession.ratioLabel,
      excludeIds: videoSession.usedVideoIds
    }
  );

  if (!result) {
    return false;
  }

  videoSession.usedVideoIds.push(result.id);
  videoSession.sentCount += 1;
  return true;
}

function hasMoreVideo(videoSession) {
  return Boolean(videoSession && videoSession.sentCount < videoSession.maxResults);
}

function initialVideoBatchSize(analysis) {
  if (analysis.textType === 'short') {
    return 1;
  }

  return Math.min(analysis.scenes.length, config.maxMediaPerRequest);
}

function enqueuePremiumRenderJob(job) {
  const position = activePremiumRenders + premiumRenderQueue.length + 1;
  premiumRenderQueue.push(job);
  setImmediate(processPremiumRenderQueue);
  return position;
}

function processPremiumRenderQueue() {
  while (activePremiumRenders < config.renderMaxConcurrent && premiumRenderQueue.length > 0) {
    const job = premiumRenderQueue.shift();
    activePremiumRenders += 1;

    runPremiumRenderJob(job)
      .catch((error) => {
        logger.error('Premium render queue job crashed.', error);
      })
      .finally(() => {
        activePremiumRenders -= 1;
        processPremiumRenderQueue();
      });
  }
}

async function runPremiumRenderJob(job) {
  let result;

  try {
    const progress = async (message) => {
      await job.telegramApi.sendMessage(job.chatId, message).catch((error) => {
        logger.warn('Premium render progress message failed.', {
          error: {
            name: error.name,
            message: error.message
          }
        });
      });
    };

    result = await renderPremiumVideo({
      analysis: job.analysis,
      onProgress: progress,
      ratioLabel: job.session.ratioLabel,
      script: job.text,
      voiceover: job.voiceover
    });

    await job.telegramApi.sendMessage(job.chatId, 'Uploading the final video...');
    await job.telegramApi.sendVideo(
      job.chatId,
      { source: result.outputPath },
      {
        caption: telegram.premiumRenderCompleteText(result, job.quota),
        supports_streaming: true
      }
    );
  } catch (error) {
    logger.error('Premium render failed.', error, {
      chatId: job.chatId,
      userId: job.userId
    });

    await job.telegramApi.sendMessage(
      job.chatId,
      telegram.premiumRenderFailedText(error),
      telegram.htmlOptions()
    ).catch((replyError) => {
      logger.error('Failed to send premium render failure message.', replyError);
    });
  } finally {
    const cleanupPaths = result?.cleanupPaths || [];
    await Promise.all(
      cleanupPaths.map((filePath) =>
        cleanupFile(filePath).catch((error) => {
          logger.warn('Premium render cleanup failed.', {
            error: {
              name: error.name,
              message: error.message
            },
            filePath
          });
        })
      )
    );
  }
}

async function sendVideoBatch(ctx, videoSession, count) {
  let sent = 0;
  let attempts = 0;
  const maxAttempts = Math.max(count, videoSession.scenes.length);

  while (sent < count && attempts < maxAttempts && hasMoreVideo(videoSession)) {
    attempts += 1;
    const didSend = await sendVideoFromSession(ctx, videoSession);

    if (didSend) {
      sent += 1;
    }
  }

  return sent;
}

async function processMediaRequest(ctx, mediaType, text, session) {
  if (!config.pexelsApiKey) {
    await ctx.reply(telegram.missingProviderKeyText());
    return;
  }

  const quota = await quotaService.checkAndIncrement(ctx.from, {
    mediaType,
    isOwner: isOwner(ctx)
  });

  if (!quota.allowed) {
    await ctx.reply(telegram.quotaReachedText(quota));
    return;
  }

  await ctx.reply(telegram.analyzingText());
  const analysis = await analyzeScript(text, mediaType);

  if (analysis.scenes.length === 0) {
    await ctx.reply(telegram.noScenesText());
    return;
  }

  if (analysis.truncated) {
    await ctx.reply(telegram.longScriptText());
  }

  await ctx.reply(telegram.searchingText(session.ratioLabel));

  if (mediaType === 'video') {
    const videoSession = {
      scenes: analysis.scenes,
      nextSceneIndex: 0,
      orientation: session.orientation,
      ratioLabel: session.ratioLabel,
      prompt: text,
      usedVideoIds: [],
      sentCount: 0,
      maxResults: config.maxMediaPerRequest
    };

    const sentVideos = await sendVideoBatch(
      ctx,
      videoSession,
      initialVideoBatchSize(analysis)
    );
    updateSession(ctx, {
      state: 'idle',
      lastVideo: videoSession
    });

    if (sentVideos === 0) {
      await ctx.reply('I could not send a clean video for that prompt. Try a simpler keyword like "city night" or choose 16:9.');
      return;
    }

    if (hasMoreVideo(videoSession)) {
      await ctx.reply(telegram.moreVideoText(), telegram.generateMoreKeyboard());
      return;
    }

    await ctx.reply(telegram.doneText(quota));
    return;
  }

  for (const scene of analysis.scenes) {
    await sendMediaForScene(ctx, scene, mediaType, {
      orientation: session.orientation,
      ratioLabel: session.ratioLabel
    });
  }

  updateSession(ctx, {
    state: 'idle',
    lastVideo: null
  });
  await ctx.reply(telegram.doneText(quota));
}

async function processPremiumVideoRequest(ctx, text, session, voiceover) {
  if (!(await userHasPremiumAccess(ctx))) {
    await ctx.reply(
      telegram.subscriptionText(await quotaService.profile(ctx.from)),
      telegram.htmlOptions(telegram.subscriptionKeyboard())
    );
    return;
  }

  if (!config.pexelsApiKey) {
    await ctx.reply(telegram.missingProviderKeyText());
    return;
  }

  const quota = await quotaService.checkAndIncrement(ctx.from, {
    mediaType: 'video',
    isOwner: isOwner(ctx)
  });

  if (!quota.allowed) {
    await ctx.reply(telegram.quotaReachedText(quota));
    return;
  }

  await ctx.reply(telegram.analyzingText());
  const analysis = await analyzeScript(text, 'video');

  if (analysis.scenes.length === 0) {
    await ctx.reply(telegram.noScenesText());
    return;
  }

  if (analysis.truncated) {
    await ctx.reply(telegram.longScriptText());
  }

  await ctx.reply(
    telegram.premiumRenderSummaryText(analysis, voiceover),
    telegram.htmlOptions()
  );
  const position = enqueuePremiumRenderJob({
    analysis,
    chatId: ctx.chat.id,
    quota,
    session: {
      orientation: session.orientation,
      ratioLabel: session.ratioLabel
    },
    telegramApi: ctx.telegram,
    text,
    userId: ctx.from.id,
    voiceover
  });

  await ctx.reply(telegram.premiumRenderQueuedText(position));

  updateSession(ctx, {
    state: 'idle',
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  });
}

async function showSubscription(ctx) {
  const profile = await quotaService.profile(ctx.from);
  await ctx.reply(
    telegram.subscriptionText(profile),
    telegram.htmlOptions(telegram.subscriptionKeyboard())
  );
}

async function showBuySubscription(ctx) {
  await ctx.reply(
    telegram.buySubscriptionText(),
    telegram.htmlOptions(telegram.subscriptionPlanKeyboard())
  );
}

async function showBalance(ctx) {
  const profile = await quotaService.profile(ctx.from);
  await ctx.reply(
    telegram.balanceText(profile),
    telegram.htmlOptions(telegram.balanceKeyboard())
  );
}

async function showTopup(ctx) {
  await ctx.reply(
    telegram.topupText(),
    telegram.htmlOptions(telegram.topupPaymentKeyboard())
  );
}

async function startImageFlow(ctx) {
  updateSession(ctx, {
    state: 'choosing_aspect_ratio',
    mediaType: 'image',
    lastVideo: null
  });
  await ctx.reply(telegram.chooseAspectText('image'), telegram.aspectRatioKeyboard());
}

async function startStockVideoFlow(ctx) {
  updateSession(ctx, {
    state: 'choosing_aspect_ratio',
    mediaType: 'video',
    videoWorkflow: 'stock',
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  });
  await ctx.reply(telegram.chooseAspectText('video'), telegram.aspectRatioKeyboard());
}

async function startPremiumVideoFlow(ctx) {
  if (!(await userHasPremiumAccess(ctx))) {
    await showSubscription(ctx);
    return;
  }

  updateSession(ctx, {
    state: 'choosing_aspect_ratio',
    mediaType: 'video',
    videoWorkflow: 'premium',
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  });
  await ctx.reply(telegram.chooseAspectText('video'), telegram.aspectRatioKeyboard());
}

async function startVideoFlow(ctx) {
  const hasPremiumAccess = await userHasPremiumAccess(ctx);
  updateSession(ctx, {
    state: 'choosing_video_workflow',
    mediaType: 'video',
    videoWorkflow: 'stock',
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  });
  await ctx.reply(
    telegram.chooseVideoWorkflowText(),
    telegram.htmlOptions(telegram.videoWorkflowKeyboard(hasPremiumAccess))
  );
}

async function startScriptFlow(ctx) {
  updateSession(ctx, {
    state: 'waiting_for_script_topic',
    mediaType: null,
    premiumScript: '',
    voiceover: null,
    lastVideo: null
  });
  await ctx.reply(telegram.scriptPromptText(), telegram.htmlOptions());
}

async function processScriptGeneration(ctx, topic) {
  await ctx.reply(telegram.scriptGeneratingText());
  const result = await generateScriptWithAi(topic);
  updateSession(ctx, {
    state: 'idle',
    premiumScript: result.script
  });
  await ctx.reply(
    telegram.generatedScriptText(result.script),
    telegram.htmlOptions(telegram.mainMenuKeyboard())
  );
}

function isInlineKeywordQuery(text) {
  const cleanText = normalizeWhitespace(text);

  if (!cleanText || cleanText.length > 60 || wordCount(cleanText) > 6) {
    return false;
  }

  if (!/[a-z0-9]/i.test(cleanText) || /[\n.!?;:]/.test(cleanText)) {
    return false;
  }

  return true;
}

function footageNotFoundInlineResult(query) {
  return {
    type: 'article',
    id: 'footage-not-found',
    title: 'Footage not found',
    description: 'Use short video keywords like: sunset car, office meeting, city night',
    input_message_content: {
      message_text: `Footage not found for "${query || 'that search'}". Try short video keywords only.`
    }
  };
}

function inlineHelpResult() {
  return {
    type: 'article',
    id: 'inline-help',
    title: 'Search 16:9 stock videos inline',
    description: 'Type short keywords after the bot username.',
    input_message_content: {
      message_text: 'Use short video keywords only, like: sunset car, office meeting, city night.'
    }
  };
}

function toInlineVideoResult(video, query, index) {
  return {
    type: 'video',
    id: `footage-video-${video.id}-${index}`,
    video_url: video.videoUrl,
    mime_type: 'video/mp4',
    thumbnail_url: video.thumbnailUrl,
    video_width: video.width,
    video_height: video.height,
    video_duration: video.duration,
    title: `${query} - 16:9 video`,
    description: 'Clean 16:9 stock footage',
    caption: [
      `Video: ${query}`,
      'Format: 16:9'
    ].filter(Boolean).join('\n').slice(0, 1000)
  };
}

function getCachedInlineVideos(cacheKey) {
  const cached = inlineVideoCache.get(cacheKey);

  if (!cached || cached.expiresAt <= Date.now()) {
    inlineVideoCache.delete(cacheKey);
    return null;
  }

  return cached.results;
}

function setCachedInlineVideos(cacheKey, results) {
  inlineVideoCache.set(cacheKey, {
    results,
    expiresAt: Date.now() + INLINE_CACHE_TTL_MS
  });
}

function inlineVideoCacheKey(searchQuery) {
  return `landscape:${String(searchQuery || '').toLowerCase()}`;
}

async function getInlineVideos(searchQuery) {
  const cacheKey = inlineVideoCacheKey(searchQuery);
  const cachedVideos = getCachedInlineVideos(cacheKey);

  if (cachedVideos) {
    return cachedVideos;
  }

  const videos = await searchInlineVideos(searchQuery, {
    orientation: 'landscape',
    timeoutMs: INLINE_SEARCH_TIMEOUT_MS
  });
  setCachedInlineVideos(cacheKey, videos);
  return videos;
}

async function preloadInlineVideos() {
  if (!config.pexelsApiKey) {
    return;
  }

  try {
    const searchQuery = buildSearchQuery(INLINE_DEFAULT_QUERY, 'video');
    await getInlineVideos(searchQuery);
    logger.info('Inline starter footage cache warmed.');
  } catch (error) {
    logger.warn('Inline starter footage cache warmup failed.', {
      error: {
        name: error.name,
        message: error.message
      }
    });
  }
}

async function handleInlineVideoSearch(ctx) {
  const query = normalizeWhitespace(ctx.inlineQuery?.query || '');
  const shouldSearchQuery = query.length >= INLINE_MIN_SEARCH_CHARS;
  const effectiveQuery = shouldSearchQuery ? query : INLINE_DEFAULT_QUERY;
  const displayQuery = shouldSearchQuery ? query : 'Popular footage';

  if (!config.pexelsApiKey || (query && !isInlineKeywordQuery(query))) {
    await ctx.answerInlineQuery([footageNotFoundInlineResult(query)], {
      cache_time: 30,
      is_personal: true
    });
    return;
  }

  try {
    const searchQuery = sanitizePrompt(effectiveQuery).slice(0, 60) || INLINE_DEFAULT_QUERY;
    const videos = await getInlineVideos(searchQuery);
    const results = videos.map((video, index) =>
      toInlineVideoResult(video, displayQuery, index)
    );

    await ctx.answerInlineQuery(
      results.length > 0 ? results : [footageNotFoundInlineResult(query || effectiveQuery)],
      {
        cache_time: shouldSearchQuery ? 15 : 120,
        is_personal: false
      }
    );
  } catch (error) {
    logger.warn('Inline video search failed.', {
      error: {
        name: error.name,
        message: error.message
      }
    });
    const starterQuery = INLINE_DEFAULT_QUERY;
    const starterVideos = getCachedInlineVideos(inlineVideoCacheKey(starterQuery)) || [];
    const fallbackResults = starterVideos.map((video, index) =>
      toInlineVideoResult(video, 'Popular footage', index)
    );

    await ctx.answerInlineQuery(
      fallbackResults.length > 0 ? fallbackResults : [footageNotFoundInlineResult(query)],
      {
        cache_time: 30,
        is_personal: true
      }
    );
  }
}

async function createBot() {
  validateConfig();
  await ensureRuntimeDirs();
  await cleanupOldDownloads();

  const bot = new Telegraf(config.telegramBotToken, {
    handlerTimeout: 120_000
  });

  bot.on('inline_query', handleInlineVideoSearch);
  bot.use(privateChatOnly);

  bot.start(async (ctx) => {
    resetSession(ctx);
    await sendStart(ctx);
  });

  bot.help(async (ctx) => {
    await ctx.reply(telegram.helpText(), telegram.htmlOptions(telegram.mainMenuKeyboard()));
  });

  bot.command('menu', async (ctx) => {
    resetSession(ctx);
    await sendStart(ctx);
  });

  bot.command('images', async (ctx) => {
    await startImageFlow(ctx);
  });

  bot.command('videos', async (ctx) => {
    await startVideoFlow(ctx);
  });

  bot.command('script', async (ctx) => {
    await startScriptFlow(ctx);
  });

  bot.command('subscription', async (ctx) => {
    await showSubscription(ctx);
  });

  bot.command('balance', async (ctx) => {
    await showBalance(ctx);
  });

  bot.command('topup', async (ctx) => {
    await showTopup(ctx);
  });

  bot.command('inline', async (ctx) => {
    await ctx.reply(
      [
        'Inline search lets you post 16:9 stock videos inside other chats.',
        '',
        'Type the bot username, then short video keywords only.',
        'Example: @yourbot sunset car',
        '',
        'Blank search shows starter footage. Long scripts are not accepted in inline mode.'
      ].join('\n')
    );
  });

  bot.command('cancel', async (ctx) => {
    resetSession(ctx);
    await ctx.reply('✅ Canceled. Choose a fresh option when you are ready.', telegram.mainMenuKeyboard());
  });

  bot.command('stats', handleOwnerStats);
  bot.command('reset_user', handleResetUser);
  bot.command('set_plan', handleSetPlan);
  bot.command('add_balance', handleAddBalance);

  bot.action('subscription', async (ctx) => {
    await ctx.answerCbQuery();
    await showSubscription(ctx);
  });

  bot.action('buy_subscription', async (ctx) => {
    await ctx.answerCbQuery();
    await showBuySubscription(ctx);
  });

  bot.action(/^choose_plan_(golden|platinum|premium)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const planId = ctx.match[1];
    await ctx.reply(
      telegram.paymentMethodText(planId),
      telegram.htmlOptions(telegram.subscriptionPaymentKeyboard(planId))
    );
  });

  bot.action(/^subscription_pay_(golden|platinum|premium)_(birr|usdt)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const [, planId, method] = ctx.match;
    await ctx.reply(
      telegram.subscriptionPaymentText(planId, method, ctx.from.id),
      telegram.htmlOptions(telegram.ownerContactKeyboard('subscription'))
    );
  });

  bot.action('balance', async (ctx) => {
    await ctx.answerCbQuery();
    await showBalance(ctx);
  });

  bot.action('topup', async (ctx) => {
    await ctx.answerCbQuery();
    await showTopup(ctx);
  });

  bot.action(/^topup_pay_(birr|usdt)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    await ctx.reply(
      telegram.topupPaymentText(method, ctx.from.id),
      telegram.htmlOptions(telegram.ownerContactKeyboard('balance'))
    );
  });

  bot.action('generate_images', async (ctx) => {
    await ctx.answerCbQuery();
    await startImageFlow(ctx);
  });

  bot.action('generate_videos', async (ctx) => {
    await ctx.answerCbQuery();
    await startVideoFlow(ctx);
  });

  bot.action('generate_script', async (ctx) => {
    await ctx.answerCbQuery();
    await startScriptFlow(ctx);
  });

  bot.action('video_workflow_stock', async (ctx) => {
    await ctx.answerCbQuery();
    await startStockVideoFlow(ctx);
  });

  bot.action('video_workflow_premium', async (ctx) => {
    await ctx.answerCbQuery();
    await startPremiumVideoFlow(ctx);
  });

  bot.action('premium_render_locked', async (ctx) => {
    await ctx.answerCbQuery('Premium only');
    await ctx.reply(
      telegram.premiumLockedText(),
      telegram.htmlOptions(telegram.subscriptionKeyboard())
    );
  });

  bot.action('aspect_9_16', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.mediaType) {
      await ctx.reply('Choose images or videos first.', telegram.mainMenuKeyboard());
      return;
    }

    const ratio = ratioSettings('9:16');
    const nextState =
      session.mediaType === 'image'
        ? 'waiting_for_image_prompt'
        : session.videoWorkflow === 'premium'
          ? 'waiting_for_premium_script'
          : 'waiting_for_video_prompt';
    updateSession(ctx, {
      ...ratio,
      state: nextState
    });
    await ctx.reply(
      nextState === 'waiting_for_premium_script'
        ? telegram.premiumPromptRequestText(ratio.ratioLabel)
        : telegram.promptRequestText(session.mediaType, ratio.ratioLabel)
    );
  });

  bot.action('aspect_16_9', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.mediaType) {
      await ctx.reply('Choose images or videos first.', telegram.mainMenuKeyboard());
      return;
    }

    const ratio = ratioSettings('16:9');
    const nextState =
      session.mediaType === 'image'
        ? 'waiting_for_image_prompt'
        : session.videoWorkflow === 'premium'
          ? 'waiting_for_premium_script'
          : 'waiting_for_video_prompt';
    updateSession(ctx, {
      ...ratio,
      state: nextState
    });
    await ctx.reply(
      nextState === 'waiting_for_premium_script'
        ? telegram.premiumPromptRequestText(ratio.ratioLabel)
        : telegram.promptRequestText(session.mediaType, ratio.ratioLabel)
    );
  });

  bot.action('generate_more_video', async (ctx) => {
    await ctx.answerCbQuery();

    if (!config.pexelsApiKey) {
      await ctx.reply(telegram.missingProviderKeyText());
      return;
    }

    const session = getSession(ctx);
    const videoSession = session.lastVideo;

    if (!videoSession) {
      await ctx.reply('Start with a video prompt first 🎬', telegram.mainMenuKeyboard());
      return;
    }

    if (!hasMoreVideo(videoSession)) {
      await ctx.reply(telegram.noMoreVideoText(), telegram.mainMenuKeyboard());
      return;
    }

    await ctx.reply(telegram.searchingText(videoSession.ratioLabel));
    const sentVideo = await sendVideoFromSession(ctx, videoSession);
    updateSession(ctx, {
      state: 'idle',
      lastVideo: videoSession
    });

    if (!sentVideo) {
      await ctx.reply(telegram.noMoreVideoText(), telegram.mainMenuKeyboard());
      return;
    }

    if (hasMoreVideo(videoSession)) {
      await ctx.reply(telegram.moreVideoText(), telegram.generateMoreKeyboard());
      return;
    }

    await ctx.reply(telegram.noMoreVideoText(), telegram.mainMenuKeyboard());
  });

  bot.action('voiceover_default', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.premiumScript) {
      await ctx.reply('Send a premium video script first.', telegram.mainMenuKeyboard());
      return;
    }

    updateSession(ctx, {
      state: 'processing',
      voiceover: {
        source: 'default'
      }
    });
    await processPremiumVideoRequest(ctx, session.premiumScript, session, {
      source: 'default'
    });
  });

  bot.action('voiceover_none', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.premiumScript) {
      await ctx.reply('Send a premium video script first.', telegram.mainMenuKeyboard());
      return;
    }

    updateSession(ctx, {
      state: 'processing',
      voiceover: {
        source: 'none'
      }
    });
    await processPremiumVideoRequest(ctx, session.premiumScript, session, {
      source: 'none'
    });
  });

  bot.action('voiceover_custom', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.premiumScript) {
      await ctx.reply('Send a premium video script first.', telegram.mainMenuKeyboard());
      return;
    }

    updateSession(ctx, {
      state: 'choosing_voice_gender',
      voiceover: {
        source: 'custom'
      }
    });
    await ctx.reply(
      telegram.voiceGenderText(),
      telegram.htmlOptions(telegram.voiceGenderKeyboard())
    );
  });

  bot.action('voiceover_back_source', async (ctx) => {
    await ctx.answerCbQuery();
    updateSession(ctx, {
      state: 'choosing_voiceover_source',
      voiceover: null
    });
    await ctx.reply(
      telegram.voiceoverSourceText(),
      telegram.htmlOptions(telegram.voiceoverSourceKeyboard())
    );
  });

  bot.action(/^voice_gender_(male|female)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const gender = ctx.match[1];
    updateSession(ctx, {
      state: 'choosing_voice_emotion',
      voiceover: {
        source: 'custom',
        gender
      }
    });
    await ctx.reply(
      telegram.voiceEmotionText(gender),
      telegram.htmlOptions(telegram.voiceEmotionKeyboard())
    );
  });

  bot.action(/^voice_emotion_(calm|energetic|professional|emotional)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx);

    if (!session.premiumScript) {
      await ctx.reply('Send a premium video script first.', telegram.mainMenuKeyboard());
      return;
    }

    const voiceover = {
      source: 'custom',
      gender: session.voiceover?.gender || 'male',
      emotion: ctx.match[1]
    };
    updateSession(ctx, {
      state: 'processing',
      voiceover
    });
    await processPremiumVideoRequest(ctx, session.premiumScript, session, voiceover);
  });

  bot.action('main_menu', async (ctx) => {
    await ctx.answerCbQuery();
    resetSession(ctx);
    await sendStart(ctx);
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(telegram.helpText(), telegram.htmlOptions(telegram.mainMenuKeyboard()));
  });

  bot.on('text', async (ctx) => {
    const text = String(ctx.message?.text || '').trim();

    if (!text) {
      return;
    }

    if (text.startsWith('/')) {
      await ctx.reply('Unknown command. Use /start or /help.');
      return;
    }

    const session = getSession(ctx);
    const state = session.state;

    if (state === 'waiting_for_image_prompt') {
      updateSession(ctx, { state: 'processing' });
      await processMediaRequest(ctx, 'image', text, session);
      return;
    }

    if (state === 'waiting_for_video_prompt') {
      updateSession(ctx, { state: 'processing' });
      await processMediaRequest(ctx, 'video', text, session);
      return;
    }

    if (state === 'waiting_for_script_topic') {
      updateSession(ctx, { state: 'processing' });
      await processScriptGeneration(ctx, text);
      return;
    }

    if (state === 'waiting_for_premium_script') {
      if (!(await userHasPremiumAccess(ctx))) {
        await ctx.reply(
          telegram.subscriptionText(await quotaService.profile(ctx.from)),
          telegram.htmlOptions(telegram.subscriptionKeyboard())
        );
        return;
      }

      updateSession(ctx, {
        state: 'choosing_voiceover_source',
        premiumScript: text
      });
      await ctx.reply(
        telegram.voiceoverSourceText(),
        telegram.htmlOptions(telegram.voiceoverSourceKeyboard())
      );
      return;
    }

    await ctx.reply('Pick Images or Videos first ✨', telegram.mainMenuKeyboard());
  });

  bot.catch(async (error, ctx) => {
    logger.error('Bot handler failed.', error, {
      updateType: ctx?.updateType
    });

    try {
      await ctx.reply('Something went wrong while processing that request. Try again.');
    } catch (replyError) {
      logger.error('Failed to send error reply.', replyError);
    }
  });

  try {
    await configureBotMenu(bot);
  } catch (error) {
    logger.warn('Telegram command menu setup failed.', {
      error: {
        name: error.name,
        message: error.message
      }
    });
  }

  preloadInlineVideos();

  return bot;
}

if (require.main === module) {
  createBot()
    .then(async (bot) => {
      const healthServer = startHealthServer(bot);
      const keepAliveTimer = startKeepAlivePinger();
      const transport = await startBotTransport(bot);

      const stop = (signal) => {
        if (transport === 'polling') {
          bot.stop(signal);
        }
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
        }
        healthServer.close(() => {
          logger.info('Health server stopped.');
        });
      };

      process.once('SIGINT', () => stop('SIGINT'));
      process.once('SIGTERM', () => stop('SIGTERM'));
    })
    .catch((error) => {
      logger.error('Telegram bot failed to start.', error);
      process.exitCode = 1;
    });
}

module.exports = {
  createBot,
  startHealthServer,
  startBotTransport,
  startKeepAlivePinger
};
