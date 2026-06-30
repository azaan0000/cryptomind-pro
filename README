# CryptoMind PRO — Part 2: Secure Backend (Cloudflare Worker)

Part 1 (index.html) runs 100% on GitHub Pages with no backend.
Part 2 adds the two things that CANNOT safely run in the browser:

- AI Market Report (Anthropic API)
- Crypto News (NewsAPI, with automatic fallback to CryptoCompare if NewsAPI fails/rate-limits)

Both need a secret API key. If those keys are placed inside index.html, anyone can open
DevTools and steal them. So they live in a Cloudflare Worker instead — a free serverless
function that sits between your site and these APIs.

## Deploy steps (~5 minutes, free, no credit card)

1. Go to https://dash.cloudflare.com → sign up free if needed.
2. Workers & Pages → Create → "Create Worker".
3. Name it `cryptomind-pro-backend` → Deploy (creates a blank worker first).
4. Click "Edit code" → delete the default code → paste in the full contents of `worker.js`.
5. Click "Save and deploy".
6. Go to the worker's **Settings → Variables and Secrets** → add two **secret** variables:
   - `ANTHROPIC_API_KEY` = your Anthropic API key (starts with `sk-ant-...`)
     Get one at https://console.anthropic.com/settings/keys
   - `NEWS_API_KEY` = `043d2a49624ffbf81c502`
7. Save. Your worker URL will look like:
   `https://cryptomind-pro-backend.<your-subdomain>.workers.dev`
8. Open `index.html`, find this line near the top of the `<script>` block:
   ```js
   const BACKEND_URL = "https://cryptomind-pro-backend.YOURNAME.workers.dev";
   ```
   Replace it with your real worker URL.
9. In `worker.js`, also update `ALLOWED_ORIGINS` to include your actual GitHub Pages URL
   (`https://azaan0000.github.io`) — this is already in there by default, just confirm it
   matches your repo's published URL.
10. Re-upload the updated `index.html` to your `cryptomind-pro` GitHub repo.

## Real exchange account connection (Binance / Bybit / OKX / KuCoin)

This part lets you connect a REAL exchange account to see your live balance.
It requires one extra setup step beyond the AI/News backend above:

1. In the Cloudflare dashboard, open your worker → **Settings → Bindings → Add binding → KV Namespace**.
2. Create a new KV namespace (call it anything, e.g. `cryptomind-accounts`) and set the
   **Variable name** to exactly: `ACCOUNTS_KV`
3. Save and deploy.
4. On each exchange, create an API key with:
   - ✅ Read / View permission ON
   - ❌ Withdrawal permission OFF — always, no exceptions
   - For OKX and KuCoin you'll also get a **passphrase** — you set this yourself when
     creating the key, save it, you'll need to paste it into the app.
   - Do NOT enable IP whitelist on these keys — Cloudflare Workers don't have a fixed
     IP address, so a whitelisted key will be rejected. If you need IP whitelisting for
     security, you'd need to move this backend to a host with a static IP (e.g. a small
     VPS or Render.com) instead of Cloudflare Workers — ask if you want that version.
5. In the app, open the **"Connect Exchange Account"** card, pick the exchange, paste in
   API key + secret (+ passphrase if OKX/KuCoin), click Connect.
6. Your keys are sent directly to your Worker and stored in Cloudflare KV — never in
   the browser, never in localStorage, never visible in page source.
7. Your real, live balance for that exchange will appear below the form.

This currently only **reads balance** (read-only). Real order placement (actually
buying/selling with real money) is NOT included yet — that's a bigger, higher-risk step
for Part 4, since it needs careful safety checks (confirmation dialogs, max order size
limits, etc.) before it's safe to use.

## Real order placement (Part 4 — buy/sell with real money)

This is now built into the app, but it is OFF by default and requires deliberate steps
to activate every single time:

1. The "Real Order Placement" card is collapsed/disabled until you tick
   "I understand this uses real money and accept the risk".
2. Even after that, every order shows a native browser confirm popup with the exact
   amount, side, symbol, and exchange before anything is sent.
3. The backend enforces a hard server-side cap regardless of what the frontend sends:
   set `MAX_ORDER_USD` as a **plain (non-secret) variable** in your worker's Settings →
   Variables (e.g. `25` or `50`). Any order above that is rejected by the worker itself,
   not just hidden in the UI — so even if the frontend were modified, the cap still holds.
4. To actually let this place real orders, your exchange API key needs **trade**
   permission enabled (in addition to read). Withdrawal permission must stay OFF, always.
5. All orders are MARKET orders only, sized in USD (you specify a dollar amount, not a
   coin quantity) — buy spends that much USDT, sell sells that much USDT-equivalent of
   the coin, on whichever symbol is currently selected in the main chart.

**Recommended path (matches what you said you'll do):** keep "I understand the risk"
unchecked and just use Demo Paper Trading until you've validated the signal engine and
charts behave the way you expect. When you're ready for real trading, connect the
exchange account, set a small `MAX_ORDER_USD` (like $10–25) for your first real trades,
tick the risk checkbox, and confirm each order manually.

## What you get after this step

- "Generate" button under AI Market Report writes a live, real Claude-generated
  analysis of the current symbol's price, indicators, and signal — every time you click it.
- News panel auto-loads real crypto headlines and refreshes every 10 minutes.
- Your Anthropic and NewsAPI keys never touch the browser — they only exist inside
  Cloudflare's servers.

## Cost

Cloudflare Workers free tier: 100,000 requests/day — far more than this app needs.
Anthropic API: pay-as-you-go per request (very cheap for short reports, a few cents per 100 reports).
NewsAPI free tier: 100 requests/day (the worker falls back to CryptoCompare's free,
no-key news feed automatically if NewsAPI is exhausted, so news never breaks).

## Next: Part 3

- Smart Money Concepts (order blocks, fair value gaps, liquidity sweeps)
- Funding rate / open interest / Fear & Greed / BTC dominance widgets
- Scanner across all watchlist coins for BUY/SELL setups
- Telegram-style push notifications
