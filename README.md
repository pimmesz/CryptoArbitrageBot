# pricebot

A small Node.js/TypeScript service that watches Binance's public mini-ticker WebSocket
stream for **every USDT spot pair** and sends a Telegram alert when any symbol moves
**+2% or more within a rolling 60-second window**.

No trading, no API keys, no money at risk. Pure market-data-in, Telegram-messages-out.

## What it does

- Connects to `wss://stream.binance.com:9443/ws/!miniTicker@arr` — one subscription
  receives a tick for every symbol roughly every second.
- Filters to pairs ending in `USDT`, excluding noisy leveraged tokens
  (`UPUSDT` / `DOWNUSDT` / `BULLUSDT` / `BEARUSDT`).
- Keeps a rolling 60-second price buffer per symbol and fires an alert when the
  current price is ≥ 2% above the minimum price in that window.
- Enforces a 15-minute per-symbol cooldown so a single pump doesn't spam the channel.
- Emits **escalation alerts** while a pump is still active. After the initial 2% alert,
  the bot keeps watching that symbol for 15 minutes and sends a follow-up message each
  time the price crosses one of the configured tiers (default `+5% / +10% / +20% / +50%`
  above the initial alert's `fromPrice`). Each tier fires at most once per pump; the
  series ends when the top tier fires or the window expires. This is the fix for the
  "+2% alert then radio silence even as the coin rips to +10%" problem.
- Cross-checks each alert against the coins available on
  [Blox](https://weareblox.com/). **Only** alerts whose asset is tradeable on
  Blox get forwarded to Telegram; the link in the message points at the Blox
  coin page so tapping it opens the Blox app directly (via universal link).
  Alerts for non-Blox assets are still logged locally for analysis.
- Logs each alert as a JSON line to stdout (PM2 captures it) and appends it to
  `./data/alerts.jsonl` for later analysis.
- Auto-reconnects the WebSocket with exponential backoff (1s → 60s, resets after
  5 minutes of stable connection) and has a 30-second silence watchdog that
  force-reconnects if Binance goes quiet.

## Telegram alert format

Initial alert:

```
🚀 BTCUSDT +2.34% in 58s
67420.15 → 69000.00
https://weareblox.com/nl-nl/bitcoin
```

Escalation alert (same pump, price has since crossed the +10% tier):

```
📈 BTCUSDT now +11.20% (passed +10%)
67420.15 → 74972.00 (4 min 30s since first alert)
https://weareblox.com/nl-nl/bitcoin
```

Tapping the link on mobile opens the Blox app (via universal link) directly on
the asset's trading page. On desktop it opens the same page in the browser.

## Environment variables

All configuration is via `.env`. Copy `.env.example` and fill in real values —
the `.env` file itself is gitignored.

| Variable              | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | Bot token from @BotFather.                               |
| `TELEGRAM_CHAT_ID`    | Target chat/group ID (groups are prefixed with `-100`).  |
| `PUMP_THRESHOLD_PCT`  | Alert threshold, in percent. Default `2.0`.              |
| `WINDOW_SECONDS`      | Rolling window length. Default `60`.                     |
| `COOLDOWN_MINUTES`    | Per-symbol suppression after an alert. Default `15`.     |
| `QUOTE_CURRENCY`      | Only watch pairs ending in this. Default `USDT`.         |
| `EXCLUDE_SUFFIXES`    | Comma-separated suffix blocklist (leveraged tokens).     |
| `LOG_LEVEL`           | `debug` \| `info` \| `warn` \| `error`. Default `info`.  |
| `BLOX_COINS_URL`      | Blox coin-list page used for filtering. Default is production. |
| `BLOX_REFRESH_HOURS`  | Refresh cadence for the Blox list. Default `6`.          |
| `MIN_ELAPSED_SECONDS` | Minimum elapsed time between the window's min price and the firing tick. Default `0`. |
| `TELEGRAM_RATE_LIMIT_PER_SEC` | Max Telegram messages/sec (Telegram's chat limit is 30/s). Default `20`. |
| `SILENCE_TIMEOUT_SECONDS` | WS silence watchdog: reconnect if no ticks arrive in this window. Default `30`. |
| `BINANCE_WS_URL`      | Optional override for the Binance WS endpoint. Leave unset outside of tests. |
| `ESCALATION_TIERS_PCT` | Comma-separated tiers (in %) for escalation follow-up alerts. Default `5,10,20,50`. Empty value disables escalations. |
| `ESCALATION_WINDOW_MINUTES` | How long after the initial alert to keep watching for escalations. Default `15`. `0` disables escalations. Range `0–240`. |

Invalid or missing values cause the process to fail fast on startup with a
clear error.

## Running locally

```bash
nvm use 20
npm install
cp .env.example .env
# ...edit .env with your real Telegram credentials
npm run build
npm start
```

Useful dev commands:

```bash
npm test          # run unit tests (vitest)
npm run test:watch
npm run dev       # run TS directly via ts-node (no build step)
```

## Deployment (PM2)

This bot runs under PM2 alongside the other services on the Ubuntu VM.

First-time install:

```bash
npm install
npm run build
pm2 start ecosystem.config.js
pm2 save
```

Day-to-day:

```bash
pm2 list                       # see status
pm2 logs pricebot --lines 100  # tail logs
pm2 restart pricebot           # after config/code changes
pm2 stop pricebot
```

After editing `.env`, restart so the new values are loaded:

```bash
pm2 restart pricebot --update-env
```

If `pm2-logrotate` isn't already installed on the box:

```bash
pm2 install pm2-logrotate
```

## Project layout

```
.
├── src/
│   ├── index.ts              # wiring (config → WS → detector → telegram)
│   ├── binance/              # WS client + reconnect/backoff
│   ├── detector/             # rolling window + threshold logic (pure, tested)
│   ├── telegram/             # send helper + alert formatter
│   ├── config.ts             # load + validate .env
│   └── logger.ts             # JSON line logger
├── test/                     # vitest specs for the detector
├── data/                     # gitignored, for alerts.jsonl
├── ecosystem.config.js       # PM2 config
├── .env.example              # placeholder values (committed)
├── .env                      # real values (gitignored)
├── tsconfig.json
├── package.json
└── README.md
```

## Known limitations

- **Spot only** — futures streams, funding, liquidations, and OI are out of scope.
- **Single exchange** — only Binance. No Bitvavo / Bybit / Kraken.
- **No persistence beyond the 60s window.** If the process restarts, the rolling
  buffer resets; the first 60 seconds after a restart can't produce alerts on
  symbols that were already mid-pump.
- **One signal only.** The single rule is "≥ X% within Y seconds." No support
  for volume-weighted pumps, divergence detection, multi-timeframe logic, etc.
- **Telegram sends are fire-and-forget.** If Telegram is down or the bot token
  is revoked, alerts are logged locally (`data/alerts.jsonl` + stdout) but will
  not retry the send.
- **No trading.** There are no exchange API keys anywhere; the bot cannot place
  orders even if its token leaks.
