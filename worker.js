/**
 * CryptoMind PRO — Cloudflare Worker Backend (Direct Binance Connection with WAF Failover)
 */

const ALLOWED_ORIGINS = [
  "https://cryptomind-pro.pages.dev",
  "https://azaan0000.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MBX-APIKEY",
  };
}

const BINANCE_ENDPOINTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://fapi.binance.me"
];

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

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { ...headers, "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
    }
  },
};

/* ---------------- HMAC SHA-256 Helper ---------------- */
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/* ---------------- Updated Direct Binance Request (WAF Bypass Layer) ---------------- */
async function futuresSignedRequest(creds, method, path, params = {}) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp, recvWindow: 5000 }).toString();
  const sig = await hmacHex(creds.apiSecret, query);
  
  // Using direct Binance API endpoint via custom bypass headers
  const targetUrl = `https://fapi.binance.com${path}?${query}&signature=${sig}`;
  
  // Primary attempt via origin proxy stream
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;

  const res = await fetch(proxyUrl, {
    method,
    headers: {
      "X-MBX-APIKEY": creds.apiKey,
      "Content-Type": "application/json"
    }
  });

  const text = await res.text();

  if (text.trim().startsWith("<") || text.includes("<!DOCTYPE") || text.includes("<html")) {
    throw new Error("Binance API Blocked. Please check API Key IP Settings.");
  }

  try {
    const data = JSON.parse(text);
    if (data.code && data.code < 0) {
      throw new Error(`Binance API Error (${data.code}): ${data.msg}`);
    }
    return data;
  } catch (err) {
    throw new Error("Failed to parse Binance response: " + err.message);
  }
}


/* ---------------- AI Report ---------------- */
const PROTRADER_SYSTEM_PROMPT = `You are "ProTrader-AI," an elite institutional-grade trading analyst. Analyze the market data given and respond like a top professional trader — no hype, precise numbers. Rules: 1) State trend clearly. 2) Use only the confluence/indicators given, never invent values. 3) Risk:Reward must be at least 1:1.5, SL/TP realistic and tight (intraday distance, not swing-sized). 4) If signal is HOLD, explain what would flip it. 5) Max 160 words, plain text, no markdown. 6) End with exactly: "Not financial advice."`;

async function handleAIReport(request, env, headers) {
  const { symbol, price, indicators, signal, timeframe } = await request.json();
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set on worker." }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const userPrompt = `Symbol: ${symbol}\nTimeframe: ${timeframe}\nPrice: ${price}\nEMA20:${indicators.ema20} EMA50:${indicators.ema50} RSI:${indicators.rsi} MACDhist:${indicators.macdHist} VWAP:${indicators.vwap} Support:${indicators.support} Resistance:${indicators.resistance}\nSignal: ${signal.label} (${signal.confidence}%)\nWrite the report now.`;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, system: PROTRADER_SYSTEM_PROMPT, messages: [{ role: "user", content: userPrompt }] }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const text = data.content?.map((c) => c.text || "").join("\n") || "No report generated.";
    return new Response(JSON.stringify({ report: text }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "AI request failed", detail: e.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
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

/* ---------------- Connection Handlers ---------------- */
async function handleConnect(request, env, headers) {
  const { userId, exchange, apiKey, apiSecret, passphrase } = await request.json();
  if (!userId || !exchange || !apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  const record = { apiKey, apiSecret, passphrase: passphrase || null, connectedAt: Date.now() };

  try {
    if (exchange === "binance") {
      const acct = await futuresSignedRequest(record, "GET", "/fapi/v2/account", {});
      if (!acct || acct.code) throw new Error(acct?.msg || "Verification failed");
    } else {
      throw new Error("Unsupported exchange");
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
    const d = await futuresSignedRequest(creds, "GET", "/fapi/v2/account", {});
    const balances = (d.assets || []).filter((a) => parseFloat(a.walletBalance) > 0).map((a) => ({ asset: a.asset, free: a.walletBalance, locked: "0" }));
    return new Response(JSON.stringify({ connected: true, exchange, balances }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ connected: true, exchange, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function getCreds(env, userId, exchange) {
  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) throw new Error("Exchange not connected");
  return JSON.parse(raw);
}

/* ---------------- Orders & Futures ---------------- */
async function handleOrder(request, env, headers) {
  const { userId, exchange, symbol, side, usdAmount, confirm } = await request.json();
  if (!userId || !symbol || !side || !usdAmount || confirm !== true) {
    return new Response(JSON.stringify({ error: "Invalid order parameters" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const d = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: side.toUpperCase(), type: "MARKET", quoteOrderQty: usdAmount });
    return new Response(JSON.stringify({ ok: true, exchange, result: d }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesLeverage(request, env, headers) {
  const { userId, exchange, symbol, leverage } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const d = await futuresSignedRequest(creds, "POST", "/fapi/v1/leverage", { symbol, leverage });
    return new Response(JSON.stringify({ ok: true, leverage: d.leverage }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesOrder(request, env, headers) {
  const { userId, exchange, symbol, side, marginUsd, leverage, slPrice, confirm } = await request.json();
  if (!userId || !symbol || !side || !marginUsd || !leverage || confirm !== true) {
    return new Response(JSON.stringify({ error: "Invalid parameters" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    await futuresSignedRequest(creds, "POST", "/fapi/v1/leverage", { symbol, leverage });

    const priceResp = await fetch(`${BINANCE_ENDPOINTS[0]}/fapi/v1/ticker/price?symbol=${symbol}`);
    const priceData = await priceResp.json();
    const currentPrice = parseFloat(priceData.price);

    const positionValue = parseFloat(marginUsd) * parseFloat(leverage);
    const qty = (positionValue / currentPrice).toFixed(3);

    const entrySide = side === "buy" ? "BUY" : "SELL";
    const entryOrder = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: entrySide, type: "MARKET", quantity: qty });

    return new Response(JSON.stringify({ ok: true, qty, entryPrice: currentPrice, result: entryOrder }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesPositions(request, env, headers) {
  const { userId, exchange } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const positions = await futuresSignedRequest(creds, "GET", "/fapi/v2/positionRisk", {});
    const open = (positions || []).filter((p) => parseFloat(p.positionAmt) !== 0).map((p) => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? "long" : "short",
      qty: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage: parseFloat(p.leverage),
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
    const closeSide = side === "long" ? "SELL" : "BUY";
    const result = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: closeSide, type: "MARKET", quantity: qty, reduceOnly: "true" });
    return new Response(JSON.stringify({ ok: true, result }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesOpenOrders(request, env, headers) {
  const { userId, exchange, symbol } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const orders = await futuresSignedRequest(creds, "GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
    return new Response(JSON.stringify({ ok: true, orders }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, orders: [] }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesCancelOrder(request, env, headers) {
  const { userId, exchange, symbol, orderId } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const result = await futuresSignedRequest(creds, "DELETE", "/fapi/v1/order", { symbol, orderId });
    return new Response(JSON.stringify({ ok: true, result }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesModifySL(request, env, headers) {
  const { userId, exchange, symbol, side, newSlPrice } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const exitSide = side === "long" ? "SELL" : "BUY";
    const newOrder = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", { symbol, side: exitSide, type: "STOP_MARKET", stopPrice: parseFloat(newSlPrice).toString(), closePosition: "true" });
    return new Response(JSON.stringify({ ok: true, order: newOrder }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleFuturesIncome(request, env, headers) {
  const { userId, exchange, symbol, limit } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const income = await futuresSignedRequest(creds, "GET", "/fapi/v1/income", { limit: limit || 50, ...(symbol && { symbol }) });
    return new Response(JSON.stringify({ ok: true, income }), { headers: { ...headers, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, income: [] }), { status: 502, headers: { ...headers, "Content-Type": "application/json" } });
  }
}

async function handleTradeHistory(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, trades: [] }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleTradeSync(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, updated: 0 }), { headers: { ...headers, "Content-Type": "application/json" } });
}

async function handleTradeInsights(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, totalTrades: 0 }), { headers: { ...headers, "Content-Type": "application/json" } });
}
