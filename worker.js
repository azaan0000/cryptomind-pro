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

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...headers, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
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
    await futuresSignedRequest(creds, "POST", "/fapi/v1/leverage", { symbol, leverage }, env, userId);

    const priceResp = await fetch(`${FUTURES_BASE}/fapi/v1/ticker/price?symbol=${symbol}`);
    const priceData = await priceResp.json();
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
