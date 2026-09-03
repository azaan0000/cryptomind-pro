/**
 * CryptoMind PRO — Cloudflare Worker Backend (v3: Futures + Leverage + Auto SL/TP)
 * -----------------------------------------------------------------------------
 * NEW in this version:
 *   POST /futures-leverage  -> set leverage for a symbol before opening a position
 *   POST /futures-order     -> open a MARKET position + auto-attach SL and TP as
 *                               exchange-side conditional orders (work even if
 *                               browser is closed — Binance's servers handle them)
 *   POST /futures-positions -> list open futures positions with live PnL
 *   POST /futures-close     -> close a position at market price
 *
 * SAFETY (unchanged from before, still enforced):
 *   - MAX_ORDER_USD caps margin per trade (set in Cloudflare Settings -> Variables)
 *   - MAX_LEVERAGE caps leverage allowed (default 20x)
 *   - Withdrawal permission must NEVER be enabled on the API key
 *   - Every order requires confirm:true from the frontend
 *
 * REQUIRED SETUP:
 *   1. Settings -> Variables -> Secrets: ANTHROPIC_API_KEY
 *   2. Settings -> Variables -> plain:  MAX_ORDER_USD = 25  (max margin per trade)
 *   3. Settings -> Variables -> plain:  MAX_LEVERAGE = 20
 *   4. Settings -> Bindings -> KV Namespace: ACCOUNTS_KV
 *   5. On Binance: enable "Reading" + "Enable Futures" on the API key
 *      (NOT "Enable Withdrawals" — ever). Activate Futures + transfer
 *      USDT to Futures wallet once on the Binance app first.
 */

const ALLOWED_ORIGINS = [
  "https://azaan0000.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { headers });

    try {
      if (url.pathname === "/ai-report" && request.method === "POST") return await handleAIReport(request, env, headers);
      if (url.pathname === "/news" && request.method === "GET") return await handleNews(url, env, headers);
      if (url.pathname === "/connect" && request.method === "POST") return await handleConnect(request, env, headers);
      if (url.pathname === "/disconnect" && request.method === "POST") return await handleDisconnect(request, env, headers);
      if (url.pathname === "/account" && request.method === "POST") return await handleAccount(request, env, headers);
      if (url.pathname === "/order" && request.method === "POST") return await handleOrder(request, env, headers);
      if (url.pathname === "/futures-leverage" && request.method === "POST") return await handleFuturesLeverage(request, env, headers);
      if (url.pathname === "/futures-order" && request.method === "POST") return await handleFuturesOrder(request, env, headers);
      if (url.pathname === "/futures-positions" && request.method === "POST") return await handleFuturesPositions(request, env, headers);
      if (url.pathname === "/futures-balance" && request.method === "POST") return await handleFuturesBalance(request, env, headers);
      if (url.pathname === "/futures-close" && request.method === "POST") return await handleFuturesClose(request, env, headers);
      if (url.pathname === "/futures-open-orders" && request.method === "POST") return await handleFuturesOpenOrders(request, env, headers);
      if (url.pathname === "/futures-cancel-order" && request.method === "POST") return await handleFuturesCancelOrder(request, env, headers);
      if (url.pathname === "/futures-modify-sl" && request.method === "POST") return await handleFuturesModifySL(request, env, headers);
      if (url.pathname === "/futures-income" && request.method === "POST") return await handleFuturesIncome(request, env, headers);
      if (url.pathname === "/trade-history" && request.method === "POST") return await handleTradeHistory(request, env, headers);
      if (url.pathname === "/trade-sync" && request.method === "POST") return await handleTradeSync(request, env, headers);
      if (url.pathname === "/trade-insights" && request.method === "POST") return await handleTradeInsights(request, env, headers);
      if (url.pathname === "/relay-poll" && request.method === "GET") return await handleRelayPoll(url, env, headers);
      if (url.pathname === "/relay-result" && request.method === "POST") return await handleRelayResult(request, env, headers);
      if (url.pathname === "/connection-status" && request.method === "POST") return await handleConnectionStatus(request, env, headers);
      if (url.pathname === "/bot-config" && request.method === "POST") return await handleBotConfigSet(request, env, headers);
      if (url.pathname === "/bot-config" && request.method === "GET") return await handleBotConfigGet(url, env, headers);
      if (url.pathname === "/bot-log" && request.method === "GET") return await handleBotLogGet(url, env, headers);

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...headers, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  },

  // 🆕 Runs on Cloudflare's own servers on the cron schedule set in
  // wrangler.toml — completely independent of your phone/browser being
  // open. This is what makes real-money auto-trading actually "always
  // on" instead of only working while the app tab is in the foreground.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoTradeScan(env));
  },
};

/* ---------------- AI Report ---------------- */
const PROTRADER_SYSTEM_PROMPT = `You are "ProTrader-AI," an elite institutional-grade trading analyst. Analyze the market data given and respond like a top professional trader — no hype, precise numbers. Rules: 1) State trend clearly. 2) Use only the confluence/indicators given, never invent values. 3) Risk:Reward must be at least 1:1.5, SL/TP realistic and tight (intraday distance, not swing-sized). 4) If signal is HOLD, explain what would flip it. 5) Max 160 words, plain text, no markdown. 6) End with exactly: "Not financial advice."`;

async function handleAIReport(request, env, headers) {
  const { symbol, price, indicators, signal, timeframe } = await request.json();
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set on worker." }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const userPrompt = `Symbol: ${symbol}\nTimeframe: ${timeframe}\nPrice: ${price}\nEMA20:${indicators.ema20} EMA50:${indicators.ema50} RSI:${indicators.rsi} MACDhist:${indicators.macdHist} VWAP:${indicators.vwap} Support:${indicators.support} Resistance:${indicators.resistance}\nSignal: ${signal.label} (${signal.confidence}%)\nWrite the report now.`;
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, system: PROTRADER_SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Network error", detail: e.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
  if (!resp.ok) {
    const errText = await resp.text();
    return new Response(JSON.stringify({ error: "AI request failed", detail: errText }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const data = await resp.json();
  const text = data.content?.map((c) => c.text || "").join("\n") || "No report generated.";
  return new Response(JSON.stringify({ report: text }), { headers: { ...headers, "Content-Type": "application/json" } });
}

/* ---------------- News ---------------- */
async function handleNews(url, env, headers) {
  try {
    const resp = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
    if (resp.ok) {
      const data = await resp.json();
      const articles = (data.Data || []).slice(0, 15).map((a) => ({ title: a.title, url: a.url, source: a.source_info?.name || a.source, publishedAt: new Date(a.published_on * 1000).toISOString() }));
      if (articles.length) return new Response(JSON.stringify({ articles }), { headers: { ...headers, "Content-Type": "application/json" } });
    }
  } catch (e) {}
  return new Response(JSON.stringify({ articles: [] }), { headers: { ...headers, "Content-Type": "application/json" } });
}

/* ---------------- Account Connection ---------------- */
async function handleConnectionStatus(request, env, headers) {
  const { userId, exchange } = await request.json();
  // Cheap check — just whether we already have stored, previously-verified
  // creds for this user. Doesn't call Binance at all, so it works even
  // when the relay/phone isn't running, and doesn't need the key/secret
  // fields to be filled in again after a page refresh.
  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange || "binance"}`);
  return new Response(JSON.stringify({ connected: !!raw }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleConnect(request, env, headers) {
  const { userId, exchange, apiKey, apiSecret, passphrase } = await request.json();
  if (!userId || !exchange || !apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const record = { apiKey, apiSecret, passphrase: passphrase || null, connectedAt: Date.now() };

  // Verify the key actually works BEFORE saving it — a bad/fake key must
  // never be reported as "Connected". We hit the Futures account endpoint
  // since that's what real trading needs (also confirms Futures + Reading
  // permission is enabled, not just spot access).
  try {
    if (exchange === "binance") {
      const acct = await futuresSignedRequest(record, "GET", "/fapi/v2/account", {}, env, userId);
      if (!acct || acct.code) throw new Error(acct?.msg || "Verification failed");
    } else {
      // Fallback for other exchanges: use the existing spot balance check.
      if (exchange === "bybit") await getBybitBalance(record);
      else if (exchange === "okx") await getOkxBalance(record);
      else if (exchange === "kucoin") await getKucoinBalance(record);
      else throw new Error("Unsupported exchange");
    }
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: "Key rejected by " + exchange + ": " + err.message }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }

  await env.ACCOUNTS_KV.put(`acct:${userId}:${exchange}`, JSON.stringify(record));
  return new Response(JSON.stringify({ ok: true, exchange }), { headers: { ...headers, "Content-Type": "application/json" } });
}
async function handleDisconnect(request, env, headers) {
  const { userId, exchange } = await request.json();
  await env.ACCOUNTS_KV.delete(`acct:${userId}:${exchange}`);
  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json" } });
}
async function handleAccount(request, env, headers) {
  const { userId, exchange } = await request.json();
  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) return new Response(JSON.stringify({ connected: false }), { headers: { ...headers, "Content-Type": "application/json" } });
  const creds = JSON.parse(raw);
  try {
    const balances = await getBinanceBalance(creds);
    return new Response(JSON.stringify({ connected: true, exchange, balances }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ connected: true, exchange, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

/* ---- crypto helper ---- */
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getBinanceBalance(creds) {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const sig = await hmacHex(creds.apiSecret, query);
  const r = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, { headers: { "X-MBX-APIKEY": creds.apiKey } });
  const d = await r.json();
  if (d.code) throw new Error(d.msg || "Binance error");
  return (d.balances || []).filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0).map((b) => ({ asset: b.asset, free: b.free, locked: b.locked }));
}

/* ---------------- Spot Order (unleveraged, legacy — kept for compatibility) ---------------- */
async function handleOrder(request, env, headers) {
  const { userId, exchange, symbol, side, usdAmount, confirm } = await request.json();
  if (!userId || !exchange || !symbol || !side || !usdAmount) return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  if (confirm !== true) return new Response(JSON.stringify({ error: "Order not confirmed" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  const maxUsd = parseFloat(env.MAX_ORDER_USD || "25");
  if (parseFloat(usdAmount) > maxUsd) return new Response(JSON.stringify({ error: `Order exceeds max $${maxUsd}.` }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });

  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) return new Response(JSON.stringify({ error: "Exchange not connected" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  const creds = JSON.parse(raw);
  try {
    const timestamp = Date.now();
    const params = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quoteOrderQty=${usdAmount}&timestamp=${timestamp}&recvWindow=5000`;
    const sig = await hmacHex(creds.apiSecret, params);
    const r = await fetch(`https://api.binance.com/api/v3/order?${params}&signature=${sig}`, { method: "POST", headers: { "X-MBX-APIKEY": creds.apiKey } });
    const d = await r.json();
    if (d.code) throw new Error(d.msg || "Order failed");
    return new Response(JSON.stringify({ ok: true, exchange, result: d }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

/* ================================================================
   FUTURES TRADING — leverage + auto SL/TP that live on Binance's
   servers (still trigger even if this browser tab is closed).
   ================================================================ */

const FUTURES_BASE = "https://fapi.binance.com";

const QTY_PRECISION = {
  BTCUSDT: 3, ETHUSDT: 3, BNBUSDT: 2, SOLUSDT: 1, XRPUSDT: 1, ADAUSDT: 0,
  DOGEUSDT: 0, TRXUSDT: 0, TONUSDT: 1, LINKUSDT: 2, AVAXUSDT: 1, LTCUSDT: 3,
  SUIUSDT: 1, APTUSDT: 1, ARBUSDT: 1, OPUSDT: 1, INJUSDT: 1,
  PEPEUSDT: 0, SHIBUSDT: 0, WIFUSDT: 0,
};
function roundQty(symbol, qty) {
  const p = QTY_PRECISION[symbol] ?? 3;
  const factor = Math.pow(10, p);
  return (Math.floor(qty * factor) / factor).toFixed(p);
}

async function futuresSignedRequest(creds, method, path, params, env, userId) {
  const timestamp = Date.now();
  // recvWindow is generous (60s, Binance's max) because the request travels
  // Worker -> KV queue -> phone relay -> Binance, which adds a few seconds
  // of delay compared to a direct call.
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 60000 }).toString();
  const sig = await hmacHex(creds.apiSecret, query);
  const url = `${FUTURES_BASE}${path}?${query}&signature=${sig}`;
  const requestHeaders = { "X-MBX-APIKEY": creds.apiKey };

  let d;
  if (env && env.RELAY_SECRET) {
    // Binance blocks requests from cloud/datacenter IPs (Cloudflare, Render, etc).
    // Route this call through the user's own phone/PC (home internet IP) instead
    // of calling Binance directly from the Worker. See relayFetch().
    d = await relayFetch(env, userId, method, url, requestHeaders);
  } else {
    const r = await fetch(url, { method, headers: requestHeaders });
    d = await r.json();
  }
  if (d.code && d.code < 0) throw new Error(d.msg || "Futures API error");
  return d;
}

/* ================================================================
   RELAY — Binance blocks Cloudflare's (and most cloud hosts') IP
   ranges. To get around this without paying for a static-IP proxy,
   the actual HTTP call to Binance is executed by a small script
   running on the user's own phone (Termux) or PC, over their home
   internet connection. The Worker never talks to Binance directly
   for signed/futures calls when RELAY_SECRET is configured — it
   queues a "job" describing the exact request, the phone polls for
   jobs, executes them, and posts the raw response back.
   ================================================================ */

async function relayFetch(env, userId, method, url, reqHeaders) {
  const jobId = crypto.randomUUID();
  const job = { userId, method, url, headers: reqHeaders, status: "pending", createdAt: Date.now() };
  await env.ACCOUNTS_KV.put(`relay_job:${jobId}`, JSON.stringify(job), { expirationTtl: 300 });

  // Poll KV for the phone's result. Cloudflare Workers can wait
  // synchronously like this within a single request's lifetime.
  const deadline = Date.now() + 25000; // 25s — the phone should poll every few seconds
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const raw = await env.ACCOUNTS_KV.get(`relay_job:${jobId}`);
    if (!raw) continue;
    const current = JSON.parse(raw);
    if (current.status === "done") {
      try { return JSON.parse(current.responseBody); }
      catch (e) { throw new Error("Relay returned non-JSON response: " + current.responseBody.slice(0, 200)); }
    }
    if (current.status === "error") throw new Error(current.error || "Relay execution failed");
  }
  throw new Error("Relay timeout — phone/PC relay script is offline or not polling. Start it and try again.");
}

async function handleRelayPoll(url, env, headers) {
  const secret = url.searchParams.get("secret");
  if (!env.RELAY_SECRET || secret !== env.RELAY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const list = await env.ACCOUNTS_KV.list({ prefix: "relay_job:" });
  const jobs = [];
  for (const key of list.keys) {
    if (jobs.length >= 5) break; // cap per poll so it stays fast on mobile
    const raw = await env.ACCOUNTS_KV.get(key.name);
    if (!raw) continue;
    const job = JSON.parse(raw);
    if (job.status !== "pending") continue;
    job.status = "sent";
    await env.ACCOUNTS_KV.put(key.name, JSON.stringify(job), { expirationTtl: 300 });
    jobs.push({ jobId: key.name.replace("relay_job:", ""), method: job.method, url: job.url, headers: job.headers });
  }
  return new Response(JSON.stringify({ jobs }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleRelayResult(request, env, headers) {
  const { secret, jobId, responseBody, error } = await request.json();
  if (!env.RELAY_SECRET || secret !== env.RELAY_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const raw = await env.ACCOUNTS_KV.get(`relay_job:${jobId}`);
  if (!raw) return new Response(JSON.stringify({ ok: false, error: "Unknown job (expired?)" }), { status: 404, headers: { ...headers, "Content-Type": "application/json" } });
  const job = JSON.parse(raw);
  if (error) { job.status = "error"; job.error = error; }
  else { job.status = "done"; job.responseBody = responseBody; }
  await env.ACCOUNTS_KV.put(`relay_job:${jobId}`, JSON.stringify(job), { expirationTtl: 60 });
  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function getCreds(env, userId, exchange) {
  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) throw new Error("Exchange not connected");
  return JSON.parse(raw);
}

async function handleFuturesLeverage(request, env, headers) {
  const { userId, exchange, symbol, leverage } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const d = await futuresSignedRequest(creds, "POST", "/fapi/v1/leverage", { symbol, leverage }, env, userId);
    return new Response(JSON.stringify({ ok: true, leverage: d.leverage }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesOrder(request, env, headers) {
  const {
    userId, exchange, symbol, side, marginUsd, leverage, slPrice, confirm,
    tpPrice,                 // legacy single TP (still supported)
    tp1Price, tp1Percent,    // partial TP stage 1 (percent of position to close, default 50)
    tp2Price,                // partial TP stage 2 (closes the remainder)
    indicators, note,        // optional context to save in the trade journal
  } = await request.json();
  if (!userId || !symbol || !side || !marginUsd || !leverage) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  if (confirm !== true) {
    return new Response(JSON.stringify({ error: "Order not confirmed" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const maxMargin = parseFloat(env.MAX_ORDER_USD || "25");
  if (parseFloat(marginUsd) > maxMargin) {
    return new Response(JSON.stringify({ error: `Margin exceeds max $${maxMargin}. Raise MAX_ORDER_USD if intentional.` }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const maxLeverage = parseFloat(env.MAX_LEVERAGE || "20");
  if (parseFloat(leverage) > maxLeverage) {
    return new Response(JSON.stringify({ error: `Leverage exceeds max ${maxLeverage}x.` }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }

  try {
    const creds = await getCreds(env, userId, exchange || "binance");

    // Force ISOLATED margin mode so a loss can never exceed this position's
    // own margin — without this, Binance's account-level default (often
    // "Cross") could let a loss draw on the rest of the Futures wallet
    // balance, not just the amount put into this trade. Binance returns an
    // error if the symbol already has open positions/orders in a different
    // mode or is already isolated — both are safe to ignore here.
    try { await futuresSignedRequest(creds, "POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" }, env, userId); } catch (e) {}

    await futuresSignedRequest(creds, "POST", "/fapi/v1/leverage", { symbol, leverage }, env, userId);

    const priceData = await futuresSignedRequest(creds, "GET", "/fapi/v1/ticker/price", { symbol }, env, userId);
    const currentPrice = parseFloat(priceData.price);
    if (!currentPrice) throw new Error("Could not fetch current price");

    const positionValue = parseFloat(marginUsd) * parseFloat(leverage);
    const qty = roundQty(symbol, positionValue / currentPrice);
    if (parseFloat(qty) <= 0) throw new Error("Quantity is zero — margin too small for this symbol/leverage");

    const entrySide = side === "buy" ? "BUY" : "SELL";
    const entryOrder = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: entrySide, type: "MARKET", quantity: qty }, env, userId);

    const results = { entry: entryOrder };
    const exitSide = side === "buy" ? "SELL" : "BUY";

    // SL always closes whatever remains of the position (works fine even
    // after a partial TP has already reduced the size).
    if (slPrice) {
      try {
        results.stopLoss = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: exitSide, type: "STOP_MARKET", stopPrice: parseFloat(slPrice).toString(), closePosition: "true" }, env, userId);
      } catch (e) { results.stopLossError = e.message; }
    }

    const journal = {
      symbol, side, qty: parseFloat(qty), entryPrice: currentPrice, leverage: parseFloat(leverage), marginUsd: parseFloat(marginUsd),
      slPrice: slPrice ? parseFloat(slPrice) : null,
      indicatorsAtEntry: indicators || null, note: note || null,
      status: "open", openedAt: Date.now(),
    };

    if (tp1Price && tp2Price) {
      // ---- Partial TP (two-stage exit): TP1 closes a % of the position at
      // a nearer target, TP2 closes the rest further out. Each is placed as
      // its own reduceOnly TAKE_PROFIT_MARKET order with an explicit
      // quantity (Binance's closePosition:true only supports ONE TP, so
      // partial exits need quantity-based orders instead).
      const pct1 = Math.min(Math.max(parseFloat(tp1Percent) || 50, 1), 99);
      const qty1 = roundQty(symbol, parseFloat(qty) * (pct1 / 100));
      const qty2raw = parseFloat(qty) - parseFloat(qty1);
      const qty2 = roundQty(symbol, qty2raw > 0 ? qty2raw : 0);

      if (parseFloat(qty1) > 0) {
        try {
          results.takeProfit1 = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: parseFloat(tp1Price).toString(), quantity: qty1, reduceOnly: "true" }, env, userId);
        } catch (e) { results.takeProfit1Error = e.message; }
      }
      if (parseFloat(qty2) > 0) {
        try {
          results.takeProfit2 = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: parseFloat(tp2Price).toString(), quantity: qty2, reduceOnly: "true" }, env, userId);
        } catch (e) { results.takeProfit2Error = e.message; }
      }

      journal.exitPlan = "partial";
      journal.tp1 = { price: parseFloat(tp1Price), qty: parseFloat(qty1), percent: pct1, orderId: results.takeProfit1?.orderId || null };
      journal.tp2 = { price: parseFloat(tp2Price), qty: parseFloat(qty2), orderId: results.takeProfit2?.orderId || null };
    } else if (tpPrice) {
      try {
        results.takeProfit = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", stopPrice: parseFloat(tpPrice).toString(), closePosition: "true" }, env, userId);
      } catch (e) { results.takeProfitError = e.message; }
      journal.exitPlan = "single";
      journal.tpPrice = parseFloat(tpPrice);
      journal.tpOrderId = results.takeProfit?.orderId || null;
    }

    journal.slOrderId = results.stopLoss?.orderId || null;
    try {
      const tradeId = await saveTradeJournal(env, userId, journal);
      results.tradeId = tradeId;
    } catch (e) { /* journal is best-effort — never block the actual trade on it */ }

    return new Response(JSON.stringify({ ok: true, qty, entryPrice: currentPrice, ...results }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesBalance(request, env, headers) {
  const { userId, exchange } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const balances = await futuresSignedRequest(creds, "GET", "/fapi/v2/balance", {}, env, userId);
    const usdt = (balances || []).find((b) => b.asset === "USDT");
    return new Response(JSON.stringify({ ok: true, available: usdt ? parseFloat(usdt.availableBalance) : 0 }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesPositions(request, env, headers) {
  const { userId, exchange } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const positions = await futuresSignedRequest(creds, "GET", "/fapi/v2/positionRisk", {}, env, userId);
    const open = (positions || []).filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? "long" : "short",
      qty: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage: parseFloat(p.leverage),
      liquidationPrice: parseFloat(p.liquidationPrice),
    }));
    return new Response(JSON.stringify({ ok: true, positions: open }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, positions: [] }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesClose(request, env, headers) {
  const { userId, exchange, symbol, side, qty } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    try { await futuresSignedRequest(creds, "DELETE", "/fapi/v1/allOpenOrders", { symbol }, env, userId); } catch (e) {}
    const closeSide = side === "long" ? "SELL" : "BUY";
    const result = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: closeSide, type: "MARKET", quantity: qty, reduceOnly: "true" }, env, userId);
    try { await closeJournalForSymbol(env, userId, symbol, "manual"); } catch (e) {}
    return new Response(JSON.stringify({ ok: true, result }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

/* ================================================================
   TRADE JOURNAL — logs every trade the bot places, and lets it be
   reconciled against Binance later so you can review what worked
   and what didn't. This is a review/insights tool, NOT an
   auto-adjusting AI — nothing here changes future trades by itself.
   ================================================================ */

async function getTradeIndex(env, userId) {
  const raw = await env.ACCOUNTS_KV.get(`trades_index:${userId}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveTradeJournal(env, userId, journal) {
  const id = `${journal.symbol}-${journal.openedAt}-${Math.random().toString(36).slice(2, 7)}`;
  journal.id = id;
  await env.ACCOUNTS_KV.put(`trade:${userId}:${id}`, JSON.stringify(journal));
  const index = await getTradeIndex(env, userId);
  index.unshift(id);
  if (index.length > 300) index.length = 300; // keep the KV bounded
  await env.ACCOUNTS_KV.put(`trades_index:${userId}`, JSON.stringify(index));
  return id;
}

// Marks the most recent OPEN journal entry for a symbol as closed. Used for
// manual closes where we don't know the exact exit price from Binance's
// response alone — /trade-sync fills in the accurate realized PnL later.
async function closeJournalForSymbol(env, userId, symbol, reason) {
  const index = await getTradeIndex(env, userId);
  for (const id of index) {
    const raw = await env.ACCOUNTS_KV.get(`trade:${userId}:${id}`);
    if (!raw) continue;
    const t = JSON.parse(raw);
    if (t.symbol === symbol && t.status === "open") {
      t.status = "closed";
      t.exitReason = t.exitReason || reason;
      t.closedAt = Date.now();
      await env.ACCOUNTS_KV.put(`trade:${userId}:${id}`, JSON.stringify(t));
      return;
    }
  }
}

async function handleTradeHistory(request, env, headers) {
  const { userId, limit } = await request.json();
  try {
    const index = await getTradeIndex(env, userId);
    const ids = index.slice(0, limit && limit > 0 ? limit : 100);
    const trades = [];
    for (const id of ids) {
      const raw = await env.ACCOUNTS_KV.get(`trade:${userId}:${id}`);
      if (raw) trades.push(JSON.parse(raw));
    }
    return new Response(JSON.stringify({ ok: true, trades }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, trades: [] }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

// Call this periodically from the frontend (e.g. on dashboard load / every
// few minutes). It checks each OPEN journal entry against Binance: if the
// position for that symbol is flat again, the SL/TP order status tells us
// which one fired, and /fapi/v1/income gives the real realized PnL.
async function handleTradeSync(request, env, headers) {
  const { userId, exchange } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const index = await getTradeIndex(env, userId);
    const positions = await futuresSignedRequest(creds, "GET", "/fapi/v2/positionRisk", {}, env, userId);
    const openQtyBySymbol = {};
    for (const p of positions || []) openQtyBySymbol[p.symbol] = Math.abs(parseFloat(p.positionAmt));

    let updated = 0;
    for (const id of index.slice(0, 100)) {
      const raw = await env.ACCOUNTS_KV.get(`trade:${userId}:${id}`);
      if (!raw) continue;
      const t = JSON.parse(raw);
      if (t.status !== "open") continue;

      const stillOpen = (openQtyBySymbol[t.symbol] || 0) > 0;
      if (stillOpen) continue; // position not flat yet, nothing to reconcile

      // Position is flat — figure out which order closed it and pull the
      // realized PnL Binance actually booked for this symbol since entry.
      let reason = "unknown";
      try {
        if (t.slOrderId) {
          const o = await futuresSignedRequest(creds, "GET", "/fapi/v1/order", { symbol: t.symbol, orderId: t.slOrderId }, env, userId);
          if (o.status === "FILLED") reason = "sl";
        }
        if (reason === "unknown" && t.tp2?.orderId) {
          const o = await futuresSignedRequest(creds, "GET", "/fapi/v1/order", { symbol: t.symbol, orderId: t.tp2.orderId }, env, userId);
          if (o.status === "FILLED") reason = "tp2";
        }
        if (reason === "unknown" && (t.tp1?.orderId || t.tpOrderId)) {
          const o = await futuresSignedRequest(creds, "GET", "/fapi/v1/order", { symbol: t.symbol, orderId: t.tp1?.orderId || t.tpOrderId }, env, userId);
          if (o.status === "FILLED") reason = t.tp1 ? "tp1" : "tp";
        }
      } catch (e) { /* order lookup can fail if it expired off Binance's books — keep reason "unknown" */ }

      let realizedPnl = null;
      try {
        const income = await futuresSignedRequest(creds, "GET", "/fapi/v1/income", { symbol: t.symbol, incomeType: "REALIZED_PNL", startTime: t.openedAt, limit: 50 }, env, userId);
        realizedPnl = (income || []).reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
      } catch (e) {}

      t.status = "closed";
      t.exitReason = reason;
      t.realizedPnl = realizedPnl;
      t.closedAt = Date.now();
      await env.ACCOUNTS_KV.put(`trade:${userId}:${id}`, JSON.stringify(t));
      updated++;
    }
    return new Response(JSON.stringify({ ok: true, updated }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

// Plain-number pattern breakdown — no ML, just grouping closed trades by
// what was true at entry so you can see what has actually worked.
async function handleTradeInsights(request, env, headers) {
  const { userId } = await request.json();
  try {
    const index = await getTradeIndex(env, userId);
    const closed = [];
    for (const id of index.slice(0, 300)) {
      const raw = await env.ACCOUNTS_KV.get(`trade:${userId}:${id}`);
      if (!raw) continue;
      const t = JSON.parse(raw);
      if (t.status === "closed" && typeof t.realizedPnl === "number") closed.push(t);
    }
    const wins = closed.filter((t) => t.realizedPnl > 0);
    const losses = closed.filter((t) => t.realizedPnl <= 0);
    const totalPnl = closed.reduce((s, t) => s + t.realizedPnl, 0);
    const reasonBreakdown = {};
    for (const t of closed) {
      reasonBreakdown[t.exitReason] = reasonBreakdown[t.exitReason] || { count: 0, pnl: 0 };
      reasonBreakdown[t.exitReason].count++;
      reasonBreakdown[t.exitReason].pnl += t.realizedPnl;
    }
    return new Response(JSON.stringify({
      ok: true,
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : null,
      totalPnl: +totalPnl.toFixed(4),
      reasonBreakdown,
    }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

/* ================================================================
   🆕 ALWAYS-ON SIGNAL ENGINE + AUTO-TRADE SCANNER
   ------------------------------------------------------------
   Everything below is a faithful port of the same indicator math
   and AI signal logic that already runs in the browser (index.html)
   — same formulas, same gates, same trade-plan rules — so decisions
   made here match what you see on screen. It runs on Cloudflare's
   own servers via the Cron Trigger in wrangler.toml, independent of
   your phone/browser being open.

   IMPORTANT: this engine can DECIDE 24/7, but actually PLACING a
   real order still calls handleFuturesOrder(), which — same as
   before — routes signed Binance calls through your phone's Termux
   relay (relay.sh). If relay.sh isn't running when a real signal
   fires, the order attempt will simply fail/timeout; the scan
   itself doesn't need your phone, only real execution does.
   ================================================================ */

const WATCHLIST = [
  {sym:'BTCUSDT',lbl:'BTC'},{sym:'ETHUSDT',lbl:'ETH'},{sym:'BNBUSDT',lbl:'BNB'},
  {sym:'SOLUSDT',lbl:'SOL'},{sym:'XRPUSDT',lbl:'XRP'},{sym:'ADAUSDT',lbl:'ADA'},
  {sym:'DOGEUSDT',lbl:'DOGE'},{sym:'TRXUSDT',lbl:'TRX'},{sym:'TONUSDT',lbl:'TON'},
  {sym:'LINKUSDT',lbl:'LINK'},{sym:'AVAXUSDT',lbl:'AVAX'},{sym:'LTCUSDT',lbl:'LTC'},
  {sym:'SUIUSDT',lbl:'SUI'},{sym:'PEPEUSDT',lbl:'PEPE'},{sym:'SHIBUSDT',lbl:'SHIB'},
  {sym:'APTUSDT',lbl:'APT'},{sym:'ARBUSDT',lbl:'ARB'},{sym:'OPUSDT',lbl:'OP'},
  {sym:'INJUSDT',lbl:'INJ'},{sym:'PAXGUSDT',lbl:'GOLD'},{sym:'WIFUSDT',lbl:'WIF'},
  {sym:'JTOUSDT',lbl:'JTO'},{sym:'JUPUSDT',lbl:'JUP'},
];
const TF_BINANCE = {'5m':'5m','1h':'1h','4h':'4h','1d':'1d'};
const TF_BYBIT   = {'5m':'5','1h':'60','4h':'240','1d':'D'};
const TF_OKX     = {'5m':'5m','1h':'1H','4h':'4H','1d':'1D'};
const TF_KUCOIN  = {'5m':'5min','1h':'1hour','4h':'4hour','1d':'1day'};

async function timedFetchW(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* ── Indicator math — copied verbatim from index.html so results match the app ── */
function ema(vals,p){const k=2/(p+1);let out=[],prev=vals[0];for(const v of vals){prev=v*k+prev*(1-k);out.push(prev);}return out;}
function rsi(vals,p=14){let out=[];let ag=0,al=0;for(let i=1;i<=p;i++){const d=vals[i]-vals[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;out.push(al===0?100:100-100/(1+ag/al));for(let i=p+1;i<vals.length;i++){const d=vals[i]-vals[i-1];if(d>0){ag=(ag*(p-1)+d)/p;al=(al*(p-1))/p;}else{ag=(ag*(p-1))/p;al=(al*(p-1)-d)/p;}out.push(al===0?100:100-100/(1+ag/al));}return out;}
function atr(candles,p=14){let tr=[];for(let i=1;i<candles.length;i++){const c=candles[i],prev=candles[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-prev.close),Math.abs(c.low-prev.close)));}let out=[];let init=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;out.push(init);for(let i=p;i<tr.length;i++)out.push((out[out.length-1]*(p-1)+tr[i])/p);return out;}
function vwap(candles){let cumPV=0,cumV=0,out=[];for(const c of candles){const tp=(c.high+c.low+c.close)/3;cumPV+=tp*c.volume;cumV+=c.volume;out.push(cumV>0?cumPV/cumV:c.close);}return out;}
function findSR(candles,lookback=80){
  const recent=candles.slice(-lookback);
  const price=recent[recent.length-1].close;
  let swHi=[],swLo=[];
  for(let i=2;i<recent.length-2;i++){
    const c=recent[i];
    if(c.high>recent[i-1].high&&c.high>recent[i-2].high&&c.high>recent[i+1].high&&c.high>recent[i+2].high) swHi.push(c.high);
    if(c.low<recent[i-1].low&&c.low<recent[i-2].low&&c.low<recent[i+1].low&&c.low<recent[i+2].low) swLo.push(c.low);
  }
  const resistances=swHi.filter(h=>h>price).sort((a,b)=>a-b);
  const supports=swLo.filter(l=>l<price).sort((a,b)=>b-a);
  return{
    support:supports[0]||recent.map(c=>c.low).sort((a,b)=>a-b)[0],
    resistance:resistances[0]||recent.map(c=>c.high).sort((a,b)=>b-a)[0],
  };
}
function adx(candles,period=14){
  if(candles.length<period*2) return{adx:0,plusDI:0,minusDI:0};
  let plusDM=[],minusDM=[],tr=[];
  for(let i=1;i<candles.length;i++){
    const up=candles[i].high-candles[i-1].high;
    const down=candles[i-1].low-candles[i].low;
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
    tr.push(Math.max(candles[i].high-candles[i].low,Math.abs(candles[i].high-candles[i-1].close),Math.abs(candles[i].low-candles[i-1].close)));
  }
  const smooth=(arr,p)=>{let out=[arr.slice(0,p).reduce((a,b)=>a+b,0)];for(let i=p;i<arr.length;i++)out.push(out[out.length-1]-out[out.length-1]/p+arr[i]);return out;};
  const sTR=smooth(tr,period), sPlus=smooth(plusDM,period), sMinus=smooth(minusDM,period);
  let dx=[];
  for(let i=0;i<sTR.length;i++){
    const pDI=sTR[i]?100*sPlus[i]/sTR[i]:0;
    const mDI=sTR[i]?100*sMinus[i]/sTR[i]:0;
    dx.push((pDI+mDI)?100*Math.abs(pDI-mDI)/(pDI+mDI):0);
  }
  const adxVal=dx.slice(-period).reduce((a,b)=>a+b,0)/Math.min(period,dx.length);
  return{adx:adxVal};
}
function obv(candles){
  let out=[0];
  for(let i=1;i<candles.length;i++){
    const prev=out[out.length-1];
    if(candles[i].close>candles[i-1].close) out.push(prev+candles[i].volume);
    else if(candles[i].close<candles[i-1].close) out.push(prev-candles[i].volume);
    else out.push(prev);
  }
  return out;
}
function fmtPriceW(p){ if(!p||isNaN(p)) return '--'; return p>=1?p.toFixed(4):p.toFixed(8); }
function detectPattern(candles){
  if(candles.length<3) return null;
  const c=candles[candles.length-1],p1=candles[candles.length-2],p2=candles[candles.length-3];
  const body=Math.abs(c.close-c.open),range=c.high-c.low||.0001;
  const upWick=c.high-Math.max(c.close,c.open),downWick=Math.min(c.close,c.open)-c.low;
  const isBull=c.close>c.open,isBear=c.close<c.open;
  if(downWick>body*2.5&&upWick<body*.5&&range>0) return{name:'Hammer',bias:'bullish'};
  if(upWick>body*2.5&&downWick<body*.5&&range>0) return{name:'Shooting Star',bias:'bearish'};
  if(isBull&&p1.close<p1.open&&c.open<p1.close&&c.close>p1.open) return{name:'Bullish Engulfing',bias:'bullish'};
  if(isBear&&p1.close>p1.open&&c.open>p1.close&&c.close<p1.open) return{name:'Bearish Engulfing',bias:'bearish'};
  if(body<range*.1) return{name:'Doji',bias:'neutral'};
  if(isBull&&upWick<body*.05&&downWick<body*.05) return{name:'Bullish Marubozu',bias:'bullish'};
  if(isBear&&upWick<body*.05&&downWick<body*.05) return{name:'Bearish Marubozu',bias:'bearish'};
  if(p2.close<p2.open&&Math.abs(p1.close-p1.open)<Math.abs(p2.close-p2.open)*.3&&isBull&&c.close>(p2.open+p2.close)/2) return{name:'Morning Star',bias:'bullish'};
  if(p2.close>p2.open&&Math.abs(p1.close-p1.open)<Math.abs(p2.close-p2.open)*.3&&isBear&&c.close<(p2.open+p2.close)/2) return{name:'Evening Star',bias:'bearish'};
  return null;
}
function detectSMC(candles){
  if(candles.length<30) return{struct:'Unknown',structBias:'neu',ob:null,fvg:null,liq:null};
  const recent=candles.slice(-30);
  let hh=0,lh=0,hl=0,ll=0,prevH=recent[0].high,prevL=recent[0].low;
  for(let i=1;i<recent.length;i++){
    if(recent[i].high>prevH){hh++;prevH=recent[i].high;} else if(recent[i].high<prevH){lh++;prevH=recent[i].high;}
    if(recent[i].low>prevL){hl++;prevL=recent[i].low;} else if(recent[i].low<prevL){ll++;prevL=recent[i].low;}
  }
  let struct='Ranging',structBias='neu';
  if(hh>lh&&hl>ll){struct='Bullish (HH HL)';structBias='bull';}
  else if(lh>hh&&ll>hl){struct='Bearish (LH LL)';structBias='bear';}
  let ob=null;
  for(let i=recent.length-3;i>0;i--){
    const c=recent[i];
    const nextUp=recent[i+1].close>recent[i+1].open&&recent[i+2].close>recent[i+2].open;
    const nextDown=recent[i+1].close<recent[i+1].open&&recent[i+2].close<recent[i+2].open;
    if(c.close<c.open&&nextUp){ob={bias:'bullish',high:c.high,low:c.low};break;}
    if(c.close>c.open&&nextDown){ob={bias:'bearish',high:c.high,low:c.low};break;}
  }
  let fvg=null;
  for(let i=recent.length-3;i>0;i--){
    const gap1=recent[i+2].low-recent[i].high;
    const gap2=recent[i].low-recent[i+2].high;
    if(gap1>0){fvg={bias:'bullish',high:recent[i+2].low,low:recent[i].high};break;}
    if(gap2>0){fvg={bias:'bearish',high:recent[i].low,low:recent[i+2].high};break;}
  }
  const highs=recent.map(c=>c.high), lows=recent.map(c=>c.low);
  const topH=Math.max(...highs),topL=Math.min(...lows);
  const eqHighs=highs.filter(h=>Math.abs(h-topH)/topH<.003).length;
  const eqLows=lows.filter(l=>Math.abs(l-topL)/topL<.003).length;
  let liq=null;
  if(eqHighs>=2) liq={bias:'bearish',level:topH};
  else if(eqLows>=2) liq={bias:'bullish',level:topL};
  return{struct,structBias,ob,fvg,liq};
}
function detectRSIDivergence(candles){
  if(!candles||candles.length<20) return null;
  const closes=candles.map(c=>c.close);
  const rsiArr=rsi(closes,14);
  const recent=candles.slice(-20);
  const recentRSI=rsiArr.slice(-20);
  const last=recent.length-1;
  let prevLowIdx=-1,prevHighIdx=-1;
  for(let i=1;i<last-1;i++){
    if(recent[i].low<recent[i-1].low&&recent[i].low<recent[i+1].low) prevLowIdx=i;
    if(recent[i].high>recent[i-1].high&&recent[i].high>recent[i+1].high) prevHighIdx=i;
  }
  if(prevLowIdx>0){
    if(recent[last].close<recent[prevLowIdx].low&&recentRSI[last]>recentRSI[prevLowIdx]) return{type:'bullish'};
  }
  if(prevHighIdx>0){
    if(recent[last].close>recent[prevHighIdx].high&&recentRSI[last]<recentRSI[prevHighIdx]) return{type:'bearish'};
  }
  return null;
}

function computeIndicatorsW(candles){
  if(!candles||candles.length<30) return null;
  const closes=candles.map(c=>c.close);
  const last=closes.length-1;
  const e20=ema(closes,20),e50=ema(closes,50);
  const r=rsi(closes,14);
  const at=atr(candles,14);
  const vw=vwap(candles);
  const sr=findSR(candles);
  const vols=candles.map(c=>c.volume);
  const avgVol=vols.slice(-20).reduce((a,b)=>a+b,0)/20;
  const emaGapPct=Math.abs(e20[last]-e50[last])/(e50[last]||1)*100;
  const adxData=adx(candles);
  const obvArr=obv(candles);
  const obvRising=obvArr.length>5&&obvArr[obvArr.length-1]>obvArr[obvArr.length-6];
  return{
    price:closes[last], ema20:e20[last], ema50:e50[last],
    rsi:r[r.length-1],
    atr:at[at.length-1]||closes[last]*0.01,
    vwap:vw[last],
    support:sr.support, resistance:sr.resistance,
    volSpike:candles[last].volume>avgVol*1.4,
    emaGapPct,
    pattern:detectPattern(candles),
    adx:adxData.adx,
    obvRising,
  };
}

// Adapted from generateSignal() in index.html — same scoring, same
// hard gates (HTF alignment + SMC reaction zone), same trade-plan
// math. Difference: htfData/deriv/news are passed in as params
// instead of read from browser globals, since this runs server-side.
function generateSignalW(ind, symbol, candles, htfData, deriv){
  if(!ind) return{direction:'HOLD',confidence:0};
  const p=ind.price;
  let score=0;

  if(ind.ema20>ind.ema50) score+=2; else score-=2;
  if(p>ind.vwap) score+=1; else score-=1;
  if(ind.rsi<35) score+=2; else if(ind.rsi>65) score-=2;
  if(p<=ind.support*1.015) score+=1;
  if(p>=ind.resistance*0.985) score-=1;
  if(ind.pattern){
    if(ind.pattern.bias==='bullish') score+=1;
    else if(ind.pattern.bias==='bearish') score-=1;
  }
  if(ind.volSpike){ if(score>0) score+=0.5; else score-=0.5; }
  const div=detectRSIDivergence(candles);
  if(div){ if(div.type==='bullish') score+=1.5; else if(div.type==='bearish') score-=1.5; }
  if(candles&&candles.length>55){
    const lookback=candles.slice(-55,-5);
    const priorHigh=Math.max(...lookback.map(c=>c.high));
    const priorLow=Math.min(...lookback.map(c=>c.low));
    const atrMin=ind.atr*0.8;
    if(p>priorHigh&&(p-priorHigh)>=atrMin) score+=2;
    if(p<priorLow&&(priorLow-p)>=atrMin) score-=2;
  }
  if(deriv){
    if(typeof deriv.fundingRate==='number'){
      if(deriv.fundingRate<=-0.03) score+=1;
      else if(deriv.fundingRate>=0.03) score-=1;
    }
    if(typeof deriv.cvdBias==='number'&&Math.abs(deriv.cvdBias)>=0.08){
      if(deriv.cvdBias>0) score+=1; else score-=1;
    }
  }
  if(score>0&&ind.obvRising) score+=0.5;
  if(score<0&&!ind.obvRising) score-=0.5;

  const weakTrend=ind.adx<20;
  if(weakTrend) score=score*0.5;

  const THRESH=3.0;
  let direction='HOLD';
  if(score>=THRESH) direction='LONG';
  else if(score<=-THRESH) direction='SHORT';

  // Hard gate 1: HTF alignment — 🛠️ TIGHTENED (backtest-informed, 2026-08-31):
  // now requires ACTIVE majority agreement (2+ of 1h/4h/1d confirming), not
  // just "not opposed". Same reasoning as index.html's gate.
  const htfTFs=['1h','4h','1d'].filter(tf=>htfData[tf]);
  const htfLong=htfTFs.filter(tf=>htfData[tf]==='LONG').length;
  const htfShort=htfTFs.filter(tf=>htfData[tf]==='SHORT').length;
  if(direction!=='HOLD'&&htfTFs.length>=2){
    if(direction==='LONG'&&htfLong<2) direction='HOLD';
    if(direction==='SHORT'&&htfShort<2) direction='HOLD';
  }

  // Hard gate 2: SMC reaction zone must agree
  if(direction!=='HOLD'&&candles&&candles.length>=30){
    const smc=detectSMC(candles);
    const wantBull=direction==='LONG';
    const nearOB=smc.ob&&smc.ob.bias===(wantBull?'bullish':'bearish')&&p>=smc.ob.low*0.997&&p<=smc.ob.high*1.003;
    const nearFVG=smc.fvg&&smc.fvg.bias===(wantBull?'bullish':'bearish')&&p>=smc.fvg.low*0.997&&p<=smc.fvg.high*1.003;
    const structOK=smc.structBias===(wantBull?'bull':'bear');
    if((nearOB||nearFVG)&&structOK) score+=1.5;
    else direction='HOLD';
  }

  const confidence=direction==='HOLD'?0:Math.min(95,Math.round(50+Math.abs(score)*8));
  let entry=null,sl=null,tp1=null,tp2=null;
  if(direction!=='HOLD'){
    entry=p;
    const atrDist=Math.max(ind.atr,p*0.001);
    const slDist=Math.min(atrDist*1.2,p*0.015);
    const tp1Dist=slDist*2.0, tp2Dist=slDist*3.5;
    if(direction==='LONG'){sl=entry-slDist;tp1=entry+tp1Dist;tp2=entry+tp2Dist;}
    else{sl=entry+slDist;tp1=entry-tp1Dist;tp2=entry-tp2Dist;}
  }
  return{direction,confidence,entry,sl,tp1,tp2};
}

/* ── Candle fetchers — same exchange fallback order as the app (Binance → Bybit → OKX → Kucoin) ── */
async function fetchBinanceCandlesW(symbol,tf,limit=200){
  const url=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TF_BINANCE[tf]}&limit=${limit}`;
  const r=await timedFetchW(url,8000);
  const d=await r.json();
  if(!Array.isArray(d)||d.length<20) throw new Error('bad data');
  return d.map(c=>({time:Math.floor(c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],takerBuyVolume:+c[9]}));
}
async function fetchBybitCandlesW(symbol,tf,limit=200){
  const url=`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${TF_BYBIT[tf]}&limit=${limit}`;
  const r=await timedFetchW(url,8000);
  const d=await r.json();
  const list=[...d.result.list].reverse();
  if(list.length<20) throw new Error('bad');
  return list.map(c=>({time:Math.floor(c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));
}
async function fetchOkxCandlesW(symbol,tf,limit=200){
  const inst=symbol.slice(0,-4)+'-USDT';
  const url=`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${TF_OKX[tf]}&limit=${limit}`;
  const r=await timedFetchW(url,8000);
  const d=await r.json();
  const list=[...d.data].reverse();
  if(list.length<20) throw new Error('bad');
  return list.map(c=>({time:Math.floor(c[0]/1000),open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));
}
async function fetchKucoinCandlesW(symbol,tf,limit=200){
  const sym=symbol.slice(0,-4)+'-USDT';
  const url=`https://api.kucoin.com/api/v1/market/candles?type=${TF_KUCOIN[tf]}&symbol=${sym}`;
  const r=await timedFetchW(url,8000);
  const d=await r.json();
  const list=[...d.data].reverse();
  if(list.length<20) throw new Error('bad');
  return list.map(c=>({time:+c[0],open:+c[1],close:+c[2],high:+c[3],low:+c[4],volume:+c[5]}));
}
async function fetchCandlesW(symbol,tf){
  for(const fn of [fetchBinanceCandlesW,fetchBybitCandlesW,fetchOkxCandlesW,fetchKucoinCandlesW]){
    try{ return await fn(symbol,tf); }catch(e){ /* try next exchange */ }
  }
  return null;
}
async function fetchDerivativesW(symbol){
  const out={fundingRate:null,cvdBias:null};
  try{
    const fr=await timedFetchW(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,6000).then(r=>r.json());
    if(fr&&fr.lastFundingRate!==undefined) out.fundingRate=parseFloat(fr.lastFundingRate)*100;
  }catch(e){}
  return out;
}

/* ── Bot config (synced from the browser whenever a toggle changes) ── */
async function handleBotConfigSet(request, env, headers){
  const body = await request.json();
  const existingRaw = await env.ACCOUNTS_KV.get('bot_config');
  const existing = existingRaw ? JSON.parse(existingRaw) : {};
  const merged = { ...existing, ...body, updatedAt: Date.now() };
  await env.ACCOUNTS_KV.put('bot_config', JSON.stringify(merged));
  return new Response(JSON.stringify({ ok: true, config: merged }), { headers: { ...headers, "Content-Type": "application/json" } });
}
async function handleBotConfigGet(url, env, headers){
  const raw = await env.ACCOUNTS_KV.get('bot_config');
  return new Response(raw || JSON.stringify({}), { headers: { ...headers, "Content-Type": "application/json" } });
}
async function handleBotLogGet(url, env, headers){
  const raw = await env.ACCOUNTS_KV.get('bot_log');
  return new Response(raw || JSON.stringify([]), { headers: { ...headers, "Content-Type": "application/json" } });
}
async function appendBotLog(env, entry){
  try{
    const raw = await env.ACCOUNTS_KV.get('bot_log');
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({ ...entry, at: Date.now() });
    await env.ACCOUNTS_KV.put('bot_log', JSON.stringify(list.slice(0, 30)));
  }catch(e){}
}

/* ── The scan itself — runs every cron tick ── */
async function runAutoTradeScan(env){
  const configRaw = await env.ACCOUNTS_KV.get('bot_config');
  if(!configRaw) return;
  const config = JSON.parse(configRaw);
  if(!config.userId || !config.realAutoTrade || !config.riskAccepted) return; // 🛠️ FIX: no log write for this — it's the normal idle state most of the time, and was burning a KV write every single tick for nothing

  // 🛠️ FIX: scan FIRST (plain HTTP candle fetches — no KV/relay involved at
  // all), and only touch the relay (positions/balance check) afterwards, and
  // only if something actually qualified. Previously this ran a relay
  // round-trip for positions AND balance on every single tick regardless of
  // whether there was ever going to be a trade — each relay round-trip costs
  // several KV writes (job queue + phone "sent" ack + phone "done" result),
  // so at a 1-minute cron that alone blew through Cloudflare's free-tier KV
  // daily write quota (1,000/day) in a few hours and locked the whole
  // account out of KV until the daily reset.
  const candidates = [];
  await Promise.all(WATCHLIST.map(async (coin)=>{
    try{
      const [c5m,c1h,c4h,c1d] = await Promise.all([
        fetchCandlesW(coin.sym,'5m'),
        fetchCandlesW(coin.sym,'1h'),
        fetchCandlesW(coin.sym,'4h'),
        fetchCandlesW(coin.sym,'1d'),
      ]);
      if(!c5m||c5m.length<60) return;

      const htfData = {};
      for(const [tf,c] of [['1h',c1h],['4h',c4h],['1d',c1d]]){
        if(!c||c.length<60) continue;
        const ind=computeIndicatorsW(c);
        if(!ind) continue;
        const s=generateSignalW(ind,coin.sym,c,{},null); // gate:false-equivalent — no HTF/SMC recursion for the HTF calc itself
        htfData[tf]=s.direction;
      }

      const ind5m = computeIndicatorsW(c5m);
      if(!ind5m) return;
      const deriv = await fetchDerivativesW(coin.sym);
      const sig = generateSignalW(ind5m, coin.sym, c5m, htfData, deriv);
      if(sig.direction!=='HOLD' && sig.confidence>=80){ // 🛠️ TIGHTENED (backtest-informed, 2026-08-31): raised from 70
        candidates.push({ symbol:coin.sym, ...sig });
      }
    }catch(e){ /* one coin failing shouldn't stop the whole scan */ }
  }));

  if(candidates.length===0){
    await appendBotLog(env,{ scanned:WATCHLIST.length, qualifying:0, opened:0 }); // 🛠️ FIX: heartbeat so the log proves the scanner is alive even on quiet ticks — cheap (one plain KV write, no relay round-trip), so it doesn't reintroduce the old quota problem
    return;
  }

  let creds;
  try{ creds = await getCreds(env, config.userId, 'binance'); }
  catch(e){ await appendBotLog(env,{ skipped:'exchange not connected', qualifying:candidates.length }); return; }

  // Open positions — read once, both for the cap and to avoid re-entering a symbol already open
  let openSymbols = new Set(), openCount = 0;
  try{
    const positions = await futuresSignedRequest(creds, "GET", "/fapi/v2/positionRisk", {}, env, config.userId);
    for(const p of positions||[]){
      if(parseFloat(p.positionAmt)!==0){ openSymbols.add(p.symbol); openCount++; }
    }
  }catch(e){
    await appendBotLog(env,{ error:'could not read open positions (relay offline, or Binance API key IP-whitelist needs refreshing — check the current relay IP): '+e.message, qualifying:candidates.length });
    return; // safer to skip this cycle than trade blind without knowing current exposure
  }
  if(openCount>=3){ await appendBotLog(env,{ skipped:'max 3 concurrent real positions reached', qualifying:candidates.length }); return; }

  let available = null;
  try{
    const balances = await futuresSignedRequest(creds, "GET", "/fapi/v2/balance", {}, env, config.userId);
    const usdt = (balances||[]).find(b=>b.asset==='USDT');
    available = usdt ? parseFloat(usdt.availableBalance) : 0;
  }catch(e){ /* fall back to requested margin below if this fails */ }

  const requestedMargin = parseFloat(config.margin)||10;
  let margin = requestedMargin;
  if(available!=null){
    margin = Math.min(requestedMargin, available*0.3);
    if(margin<1){ await appendBotLog(env,{ skipped:'available balance too low to size a trade', qualifying:candidates.length }); return; }
  }

  const scanList = WATCHLIST.filter(c=>!openSymbols.has(c.sym));
  const filteredCandidates = candidates.filter(c=>scanList.some(s=>s.sym===c.symbol));

  filteredCandidates.sort((a,b)=>b.confidence-a.confidence);
  const slotsLeft = 3-openCount;
  const chosen = filteredCandidates.slice(0, Math.max(0,slotsLeft));

  if(chosen.length===0){
    await appendBotLog(env,{ scanned:scanList.length, qualifying:filteredCandidates.length, opened:0 });
    return;
  }

  const opened = [];
  for(const c of chosen){
    const side = c.direction==='LONG'?'buy':'sell';
    if(config.liveTrading===true){
      try{
        const fakeReq = new Request('https://internal/futures-order', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            userId:config.userId, exchange:'binance', symbol:c.symbol, side,
            marginUsd:margin, leverage:3,
            slPrice:c.sl.toFixed(6), tp1Price:c.tp1.toFixed(6), tp2Price:c.tp2.toFixed(6), tp1Percent:50,
            confirm:true, note:`Cron scan — confidence ${c.confidence}%`,
          }),
        });
        const resp = await handleFuturesOrder(fakeReq, env, {});
        const data = await resp.json();
        opened.push({ symbol:c.symbol, side, confidence:c.confidence, ok:data.ok!==false });
      }catch(e){
        opened.push({ symbol:c.symbol, side, confidence:c.confidence, ok:false, error:e.message });
      }
    } else {
      // Shadow mode — decision logged, no real order sent, until liveTrading is switched on
      opened.push({ symbol:c.symbol, side, confidence:c.confidence, shadowOnly:true });
    }
  }

  await appendBotLog(env,{ scanned:scanList.length, qualifying:candidates.length, opened:opened.length, mode:config.liveTrading?'live':'shadow', trades:opened });
}
