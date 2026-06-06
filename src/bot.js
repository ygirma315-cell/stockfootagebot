const http = require('http');
const { Telegraf } = require('telegraf');
const config = require('./config');
const logger = require('./utils/logger');
const { cleanupFile, cleanupOldDownloads, ensureRuntimeDirs } = require('./utils/fileCleanup');
const { analyzeScript } = require('./services/scriptAnalyzer');
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
  wordCount
} = require('./utils/textTools');

const userSessions = new Map();

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
      downloadedFile =
        mediaType === 'image' ? await downloadImage(result) : await downloadVideo(result);

      const caption = telegram.sceneCaption(scene, mediaType, result, options.ratioLabel);

      if (mediaType === 'image') {
        await ctx.replyWithPhoto({ source: downloadedFile }, { caption });
      } else {
        await ctx.replyWithVideo(
          { source: downloadedFile },
          {
            caption,
            supports_streaming: true
          }
        );
      }

      return result;
    } catch (error) {
      await cleanupFile(downloadedFile).catch(() => {});
      downloadedFile = null;
      excludeIds.push(result.id);

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
      await ctx.reply(telegram.doneText(quota));
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
  await ctx.reply(telegram.searchingText(session.ratioLabel));

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
    premiumScript: '',
    voiceover: null,
    lastVideo: videoSession
  });

  if (sentVideos === 0) {
    await ctx.reply(telegram.doneText(quota));
    return;
  }

  if (hasMoreVideo(videoSession)) {
    await ctx.reply(telegram.moreVideoText(), telegram.generateMoreKeyboard());
    return;
  }

  await ctx.reply(telegram.doneText(quota));
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
  if (await userHasPremiumAccess(ctx)) {
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
      telegram.htmlOptions(telegram.videoWorkflowKeyboard())
    );
    return;
  }

  await startStockVideoFlow(ctx);
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
    id: `pexels-video-${video.id}-${index}`,
    video_url: video.videoUrl,
    mime_type: 'video/mp4',
    thumbnail_url: video.thumbnailUrl,
    video_width: video.width,
    video_height: video.height,
    video_duration: video.duration,
    title: `${query} - 16:9 video`,
    description: video.userName ? `Video by ${video.userName}` : 'Stock video',
    caption: [
      `Video: ${query}`,
      'Format: 16:9',
      video.userName ? `Credit: ${video.userName}` : '',
      video.pageUrl ? `Source: ${video.pageUrl}` : ''
    ].filter(Boolean).join('\n').slice(0, 1000)
  };
}

async function handleInlineVideoSearch(ctx) {
  const query = normalizeWhitespace(ctx.inlineQuery?.query || '');
  const effectiveQuery = query || 'cinematic nature';

  if (!config.pexelsApiKey || (query && !isInlineKeywordQuery(query))) {
    await ctx.answerInlineQuery([footageNotFoundInlineResult(query)], {
      cache_time: 30,
      is_personal: true
    });
    return;
  }

  try {
    const searchQuery = buildSearchQuery(effectiveQuery, 'video');
    const videos = await searchInlineVideos(searchQuery, {
      orientation: 'landscape'
    });
    const results = videos.map((video, index) =>
      toInlineVideoResult(video, query || 'Popular footage', index)
    );

    await ctx.answerInlineQuery(
      results.length > 0 ? results : [footageNotFoundInlineResult(query || effectiveQuery)],
      {
        cache_time: query ? 20 : 60,
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
    await ctx.answerInlineQuery([footageNotFoundInlineResult(query)], {
      cache_time: 30,
      is_personal: true
    });
  }
}

async function createBot() {
  validateConfig();
  await ensureRuntimeDirs();
  await cleanupOldDownloads();

  const bot = new Telegraf(config.telegramBotToken, {
    handlerTimeout: 120_000
  });

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

  bot.on('inline_query', handleInlineVideoSearch);

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

  bot.action('video_workflow_stock', async (ctx) => {
    await ctx.answerCbQuery();
    await startStockVideoFlow(ctx);
  });

  bot.action('video_workflow_premium', async (ctx) => {
    await ctx.answerCbQuery();
    await startPremiumVideoFlow(ctx);
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
