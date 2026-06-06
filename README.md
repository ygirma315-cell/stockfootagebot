# Stock Footage Telegram Bot

A Telegram bot that turns a short idea or a longer script into stock image or video results. Users choose images or videos with inline buttons, send a prompt, and the bot analyzes it into searchable visual scenes.

## Install

```bash
npm install
```

Node.js 18.17 or newer is required.

## Environment

Create a `.env` file in the project root and fill in:

```env
TELEGRAM_BOT_TOKEN=
PEXELS_API_KEY=
AI_API_KEY=
VOICEOVER_API_KEY=
OWNER_USERNAME=
OWNER_TELEGRAM_ID=
MAX_MEDIA_PER_REQUEST=8
QUOTA_TIMEZONE=UTC
```

`AI_API_KEY` is optional. When it is present, the bot tries an OpenAI-compatible chat completions API to turn medium and long scripts into JSON scene queries. You can also set `AI_API_BASE_URL` and `AI_MODEL` if your provider needs a specific endpoint or model.

`VOICEOVER_API_KEY` is kept separate for premium voice-over work. Keep real keys in `.env` locally and in Render environment variables, never in source code.

`.env` is ignored by git. Do not commit real tokens.

## Run Locally

```bash
npm start
```

The bot uses Telegram long polling, so it does not need a web server for local use.

## Commands

`/start` opens the main menu with image, video, and help buttons.

`/menu` opens the main menu again.

`/help` explains the flow.

`/cancel` clears the current waiting state.

`/stats` shows local usage totals. Only the configured owner can use it.

`/reset_user <telegram_user_id>` resets one user's daily quota. Only the configured owner can use it.

`/set_plan <telegram_user_id> <free|golden|platinum|premium>` activates a user's subscription after manual payment. Only the configured owner can use it.

`/add_balance <telegram_user_id> <amount> <birr|usdt>` credits a user's balance after manual top-up. Only the configured owner can use it.

The owner is checked by Telegram ID from `OWNER_TELEGRAM_ID` and by Telegram username from `OWNER_USERNAME`, with or without the leading `@`. The ID is the safest option because usernames can change.

## Quota

Usage is stored locally in `data/usage.json`. The file is created automatically if it does not exist.

Each media prompt counts against that media type. Daily counts reset by calendar date using `QUOTA_TIMEZONE`, which defaults to UTC. The configured owner is not limited.

Plans:

- Free: 50 photos/day and 50 videos/day.
- Golden: $3/month, 300 photos/day and 200 videos/day.
- Platinum: $4/month, 400 photos/day and 300 videos/day.
- Premium: $10/month, unlimited fair-use requests plus the premium script/caption/voice-over flow.

Payments are manual for now. The bot lets users choose Birr or USDT and sends them to the owner inbox. After confirming payment, use `/set_plan` or `/add_balance`.

## Script Analysis

Short prompts under about 20 words are treated as one scene. For example:

```txt
a dog on the sunset
```

becomes one stock media query similar to:

```txt
dog sunset cinematic
```

Medium and long scripts are split into useful visual scenes. The bot prefers paragraphs first, then strong punctuation only when needed. If AI is configured, it asks for JSON scene search queries. If AI is not configured or fails, a local heuristic extracts visual terms and builds queries.

## Stock Media Behavior

Images use the configured stock photo provider.

Videos use the configured stock video provider and prefer MP4 files that are good quality without being too large.

Downloads are saved temporarily in `downloads/`, sent to Telegram, and then removed. Failed or oversized downloads are cleaned up safely.

## Deploy Later

For simple deployment, run the same `npm start` command on a VPS, Railway, Render, Fly.io, or another Node-capable host.

Set the environment variables in the host dashboard instead of uploading `.env`.

Locally, this project uses Telegram long polling. On Render Web Services, it automatically switches to Telegram webhooks using Render's `RENDER_EXTERNAL_URL`, so only the deployed web service receives updates.

For Render Web Service or Background Worker:

- Build command: `npm install`
- Start command: `npm start`

Leave Root Directory blank.

For Render Web Services, the app auto-pings its own `/health` endpoint every 10 minutes when Render provides `RENDER_EXTERNAL_URL`. You can disable this with `KEEP_ALIVE_ENABLED=false` or change the interval with `KEEP_ALIVE_INTERVAL_MINUTES`.

The default webhook path is `/telegram-webhook`. You can override webhook behavior with `WEBHOOK_ENABLED`, `WEBHOOK_PATH`, `WEBHOOK_URL`, and `WEBHOOK_SECRET_TOKEN`.

For high traffic, you can later switch to Telegram webhooks and replace the local JSON quota file with a database.
