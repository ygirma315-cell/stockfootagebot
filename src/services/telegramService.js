const { Markup } = require('telegraf');
const config = require('../config');
const { PLANS, formatLimit, getPlan } = require('./plans');

function ownerUsername() {
  return String(config.ownerUsername || '').replace(/^@/, '').trim();
}

function ownerHandle() {
  const username = ownerUsername();
  return username ? `@${username}` : '@OWNER_USERNAME';
}

function ownerInboxUrl() {
  const username = ownerUsername();
  return username ? `https://t.me/${username}` : '';
}

function htmlOptions(keyboard) {
  return {
    parse_mode: 'HTML',
    ...(keyboard || {})
  };
}

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🖼 Images', 'generate_images'),
      Markup.button.callback('🎬 Videos', 'generate_videos')
    ],
    [
      Markup.button.callback('💎 Subscription', 'subscription'),
      Markup.button.callback('💰 Add Balance', 'balance')
    ],
    [Markup.button.callback('✨ Help', 'help')]
  ]);
}

function subscriptionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Buy subscription', 'buy_subscription')],
    [Markup.button.callback('↩️ Back', 'main_menu')]
  ]);
}

function subscriptionPlanKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Golden $3', 'choose_plan_golden'),
      Markup.button.callback('Platinum $4', 'choose_plan_platinum')
    ],
    [Markup.button.callback('Premium $10', 'choose_plan_premium')],
    [Markup.button.callback('↩️ Back', 'subscription')]
  ]);
}

function subscriptionPaymentKeyboard(planId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Birr', `subscription_pay_${planId}_birr`),
      Markup.button.callback('USDT', `subscription_pay_${planId}_usdt`)
    ],
    [Markup.button.callback('↩️ Back', 'buy_subscription')]
  ]);
}

function ownerContactKeyboard(backAction = 'main_menu') {
  const inboxUrl = ownerInboxUrl();
  const rows = [];

  if (inboxUrl) {
    rows.push([Markup.button.url('📩 Message owner', inboxUrl)]);
  }

  rows.push([Markup.button.callback('↩️ Back', backAction)]);
  return Markup.inlineKeyboard(rows);
}

function balanceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Top up', 'topup')],
    [Markup.button.callback('↩️ Back', 'main_menu')]
  ]);
}

function topupPaymentKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Birr', 'topup_pay_birr'),
      Markup.button.callback('USDT', 'topup_pay_usdt')
    ],
    [Markup.button.callback('↩️ Back', 'balance')]
  ]);
}

function aspectRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'aspect_9_16'),
      Markup.button.callback('🖥 16:9', 'aspect_16_9')
    ],
    [Markup.button.callback('↩️ Back', 'main_menu')]
  ]);
}

function videoWorkflowKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎬 Stock clips', 'video_workflow_stock')],
    [Markup.button.callback('🚀 Premium render kit', 'video_workflow_premium')],
    [Markup.button.callback('↩️ Back', 'main_menu')]
  ]);
}

function voiceoverSourceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎙 Default AI voice-over', 'voiceover_default')],
    [Markup.button.callback('🎧 Choose voice style', 'voiceover_custom')],
    [Markup.button.callback('🔇 No voice-over', 'voiceover_none')]
  ]);
}

function voiceGenderKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Male', 'voice_gender_male'),
      Markup.button.callback('Female', 'voice_gender_female')
    ],
    [Markup.button.callback('↩️ Back', 'voiceover_back_source')]
  ]);
}

function voiceEmotionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Calm', 'voice_emotion_calm'),
      Markup.button.callback('Energetic', 'voice_emotion_energetic')
    ],
    [
      Markup.button.callback('Professional', 'voice_emotion_professional'),
      Markup.button.callback('Emotional', 'voice_emotion_emotional')
    ],
    [Markup.button.callback('↩️ Back', 'voiceover_custom')]
  ]);
}

function generateMoreKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔁 More same prompt', 'generate_more_video'),
      Markup.button.callback('🆕 New prompt', 'main_menu')
    ]
  ]);
}

function welcomeText() {
  return [
    '✨ Welcome to your stock footage bot!',
    'Choose images, videos, subscriptions, balance, or help from the menu below.'
  ].join('\n\n');
}

function helpText() {
  return [
    '<b>How it works</b>',
    '🖼 Images: pick a ratio, then send a prompt or script.',
    '🎬 Videos: pick a ratio, then send a prompt or script.',
    '💎 Subscription: see plans and contact the owner to activate.',
    '💰 Add Balance: request a Birr or USDT top-up.',
    '🔎 Inline: type this bot username in any chat, then short video keywords only.',
    '',
    'Use /menu anytime to open the buttons again.',
    'Use /cancel to reset your current flow.'
  ].join('\n');
}

function subscriptionText(profile) {
  const plan = profile?.plan || PLANS.free;

  return [
    '<b>💎 Subscriptions</b>',
    `Current plan: <b>${plan.name}</b>`,
    '',
    '<b>Free</b>',
    '• 50 photos/day',
    '• 50 videos/day',
    '',
    '<b>Golden - $3/month</b>',
    '• 300 photos/day',
    '• 200 videos/day',
    '• Advanced context awareness',
    '• Good for marketing and automation workflows',
    '',
    '<b>Platinum - $4/month</b>',
    '• 400 photos/day',
    '• 300 videos/day',
    '• More room for daily content production',
    '• Better for creators and small teams',
    '',
    '<b>Premium - $10/month</b>',
    '• Unlimited fair-use media requests',
    '• Script-to-video render kit',
    '• Captions + voice-over workflow',
    '• Built for YouTube/TikTok automation'
  ].join('\n');
}

function buySubscriptionText() {
  return '<b>Choose a subscription</b>\nPick the plan you want to buy.';
}

function paymentMethodText(planId) {
  const plan = getPlan(planId);
  return `<b>${plan.name}</b> selected (${plan.priceLabel}).\nChoose your payment method.`;
}

function subscriptionPaymentText(planId, method, userId) {
  const plan = getPlan(planId);
  const methodLabel = method === 'birr' ? 'Birr' : 'USDT';

  return [
    '<b>Payment request ready ✅</b>',
    `Plan: <b>${plan.name}</b>`,
    `Price: <b>${plan.priceLabel}</b>`,
    `Method: <b>${methodLabel}</b>`,
    `Your Telegram ID: <code>${userId}</code>`,
    '',
    `Message the owner ${ownerHandle()} to finish payment and activate your plan.`
  ].join('\n');
}

function balanceText(profile) {
  const balances = profile?.entry?.balances || { birr: 0, usdt: 0 };

  return [
    '<b>💰 Balance</b>',
    `Birr: <b>${Number(balances.birr || 0).toFixed(2)}</b>`,
    `USDT: <b>${Number(balances.usdt || 0).toFixed(2)}</b>`,
    '',
    'Top-ups are handled manually by the owner for now.'
  ].join('\n');
}

function topupText() {
  return '<b>Top up balance</b>\nChoose how you want to pay.';
}

function topupPaymentText(method, userId) {
  const methodLabel = method === 'birr' ? 'Birr' : 'USDT';

  return [
    '<b>Top-up request ready ✅</b>',
    `Method: <b>${methodLabel}</b>`,
    `Your Telegram ID: <code>${userId}</code>`,
    '',
    `Message the owner ${ownerHandle()} with the amount you want to add.`
  ].join('\n');
}

function chooseVideoWorkflowText() {
  return [
    '<b>Choose video workflow</b>',
    'Stock clips sends matching footage.',
    'Premium render kit prepares clips, captions, and voice-over settings.'
  ].join('\n');
}

function chooseAspectText(mediaType) {
  const label = mediaType === 'image' ? 'image' : 'video';
  return `Nice. Choose the ${label} shape next 🎨`;
}

function promptRequestText(mediaType, ratioLabel) {
  const label = mediaType === 'image' ? 'image' : 'video';
  return `Locked in ${ratioLabel} ✅\n\nSend your ${label} idea, prompt, or script.`;
}

function premiumPromptRequestText(ratioLabel) {
  return [
    `Locked in ${ratioLabel} ✅`,
    '',
    'Send the full script for your automation video.',
    'I will prepare stock clips, caption lines, and voice-over settings.'
  ].join('\n');
}

function voiceoverSourceText() {
  return '<b>Voice-over</b>\nChoose how this premium render should handle voice-over.';
}

function voiceGenderText() {
  return '<b>Voice style</b>\nChoose a voice type.';
}

function voiceEmotionText(gender) {
  return `<b>${gender === 'female' ? 'Female' : 'Male'} voice</b>\nChoose the emotion/style.`;
}

function premiumRenderSummaryText(analysis, voiceover) {
  const captions = analysis.scenes
    .slice(0, 10)
    .map((scene) => `${scene.sceneNumber}. ${scene.description}`)
    .join('\n');
  const voiceLabel =
    voiceover.source === 'none'
      ? 'No voice-over'
      : voiceover.source === 'default'
        ? 'Default AI voice-over'
        : `${voiceover.gender} / ${voiceover.emotion}`;

  return [
    '<b>🚀 Premium render kit</b>',
    `Voice-over: <b>${voiceLabel}</b>`,
    '',
    '<b>Caption draft</b>',
    captions,
    '',
    'I am sending the matching clips now.'
  ].join('\n').slice(0, 3900);
}

function quotaReachedText(quota) {
  const mediaLabel = quota?.mediaType === 'image' ? 'photo' : 'video';
  const plan = quota?.plan || PLANS.free;
  return [
    `⛔ Your ${mediaLabel} daily limit is reached on ${plan.name}.`,
    `Contact the owner ${ownerHandle()} or upgrade from Subscription.`
  ].join('\n');
}

function longScriptText() {
  return `📜 This script is long, so I generated the first useful media results only. Contact the owner ${ownerHandle()} to increase your quota.`;
}

function missingProviderKeyText() {
  return '⚙️ Media search is not configured yet. Ask the owner to finish setup, then try again.';
}

function analyzingText() {
  return '🧠 Analyzing your idea...';
}

function searchingText(ratioLabel) {
  return `🔎 Searching stock footage in ${ratioLabel}...`;
}

function noMediaText() {
  return "😅 I couldn't find a clean match for this scene. Try a clearer prompt.";
}

function noScenesText() {
  return "😅 I couldn't detect clear visual scenes in that text. Try a more visual prompt.";
}

function doneText(quota) {
  if (quota?.unlimited) {
    return '✅ Done. Owner/Premium access: unlimited fair use.';
  }

  const mediaLabel = quota?.mediaType === 'image' ? 'photo' : 'video';
  const remaining = Number(quota?.remaining || 0);
  return `✅ Done. You have ${remaining} ${mediaLabel} request(s) left today.`;
}

function moreVideoText() {
  return 'Want another video from the same prompt? 🔁';
}

function noMoreVideoText() {
  return '✅ I reached the max useful video results for that prompt. Start a new one when you are ready.';
}

function planUpdatedText(entry) {
  const plan = getPlan(entry.plan);
  return `✅ Plan updated for ${entry.telegramUserId}: ${plan.name}.`;
}

function balanceUpdatedText(entry, currency) {
  const label = currency === 'birr' ? 'Birr' : 'USDT';
  return `✅ Balance updated for ${entry.telegramUserId}: ${Number(entry.balances[currency] || 0).toFixed(2)} ${label}.`;
}

function sceneCaption(scene, mediaType, result, ratioLabel = '16:9') {
  const label = mediaType === 'image' ? '🖼 Image' : '🎬 Video';

  return `${label} ${scene.sceneNumber} • ${ratioLabel}\n✨ ${scene.pexelsQuery}`.slice(0, 950);
}

function planLimitLine(planId) {
  const plan = getPlan(planId);
  return `${plan.name}: ${formatLimit(plan.dailyImageLimit)} photos/day, ${formatLimit(plan.dailyVideoLimit)} videos/day`;
}

module.exports = {
  analyzingText,
  aspectRatioKeyboard,
  balanceKeyboard,
  balanceText,
  balanceUpdatedText,
  buySubscriptionText,
  chooseAspectText,
  chooseVideoWorkflowText,
  doneText,
  generateMoreKeyboard,
  helpText,
  htmlOptions,
  longScriptText,
  mainMenuKeyboard,
  missingProviderKeyText,
  moreVideoText,
  noMediaText,
  noMoreVideoText,
  noScenesText,
  ownerContactKeyboard,
  paymentMethodText,
  planLimitLine,
  planUpdatedText,
  premiumPromptRequestText,
  premiumRenderSummaryText,
  promptRequestText,
  quotaReachedText,
  sceneCaption,
  searchingText,
  subscriptionKeyboard,
  subscriptionPaymentKeyboard,
  subscriptionPaymentText,
  subscriptionPlanKeyboard,
  subscriptionText,
  topupPaymentKeyboard,
  topupPaymentText,
  topupText,
  videoWorkflowKeyboard,
  voiceEmotionKeyboard,
  voiceEmotionText,
  voiceGenderKeyboard,
  voiceGenderText,
  voiceoverSourceKeyboard,
  voiceoverSourceText,
  welcomeText
};
