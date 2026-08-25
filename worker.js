/**
 * CryptoMind PRO — Cloudflare Worker Backend (Part 2)
 * ----------------------------------------------------
 * Purpose: keep API keys OFF the browser/GitHub Pages frontend.
 * Handles:
 *   POST /ai-report   -> calls Anthropic API, returns AI market analysis
 *   GET  /news        -> proxies NewsAPI (or fallback), returns crypto news
 *
 * DEPLOY STEPS (free, ~5 minutes):
 * 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 * 2. Name it: cryptomind-pro-backend
 * 3. Paste this whole file into the editor, replacing the default code
 * 4. Go to Settings -> Variables -> Add these as "Secret" (NOT plain text):
 *      ANTHROPIC_API_KEY = your Anthropic key (sk-ant-...)
 *      NEWS_API_KEY      = 043d2a49624ffbf81c502
 * 5. Deploy. You'll get a URL like:
 *      https://cryptomind-pro-backend.YOURNAME.workers.dev
 * 6. Put that URL into BACKEND_URL in app-config.js (Part 2 frontend file)
 *
 * Cloudflare Workers free tier = 100,000 requests/day. Enough for this app.
 */

const ALLOWED_ORIGINS = [
  "https://azaan0000.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500" // for local testing, remove later if you want
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

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    try {
      if (url.pathname === "/ai-report" && request.method === "POST") {
        return await handleAIReport(request, env, headers);
      }
      if (url.pathname === "/news" && request.method === "GET") {
        return await handleNews(url, env, headers);
      }
      if (url.pathname === "/connect" && request.method === "POST") {
        return await handleConnect(request, env, headers);
      }
      if (url.pathname === "/disconnect" && request.method === "POST") {
        return await handleDisconnect(request, env, headers);
      }
      if (url.pathname === "/account" && request.method === "POST") {
        return await handleAccount(request, env, headers);
      }
      if (url.pathname === "/order" && request.method === "POST") {
        return await handleOrder(request, env, headers);
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};

/* ---------------- AI Report (Anthropic) ---------------- */
async function handleAIReport(request, env, headers) {
  const body = await request.json();
  const { symbol, price, indicators, signal, timeframe } = body;

  const prompt = `You are a professional crypto market analyst. Write a concise market report (max 180 words) for ${symbol} on the ${timeframe} timeframe.

Current price: ${price}
Indicators: EMA20=${indicators.ema20}, EMA50=${indicators.ema50}, RSI=${indicators.rsi}, MACD histogram=${indicators.macdHist}, VWAP=${indicators.vwap}, Support=${indicators.support}, Resistance=${indicators.resistance}
Algorithmic signal: ${signal.label} (confidence ${signal.confidence}%)

Write in plain text, no markdown headers. Cover: trend direction, what the indicators suggest, key levels to watch, and a balanced risk note. End with a one-line disclaimer that this is not financial advice.`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return new Response(JSON.stringify({ error: "AI request failed", detail: errText }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const data = await resp.json();
  const text = data.content?.map((c) => c.text || "").join("\n") || "No report generated.";

  return new Response(JSON.stringify({ report: text }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/* ---------------- Exchange Account Connection ----------------
   IMPORTANT SETUP:
   1. In Cloudflare dashboard -> Workers & Pages -> your worker -> Settings -> Bindings
      -> Add KV Namespace binding. Create a namespace called ACCOUNTS_KV and bind it
      with variable name: ACCOUNTS_KV
   2. This is how user API keys/secrets get stored server-side (never in the browser,
      never in localStorage). They are looked up by a "userId" the person sets once
      in the frontend (acts like a simple account passcode for this single-user tool).
   3. When creating exchange API keys: DO NOT enable withdrawal permissions, ever.
      Only enable "read" (and "trade" if you actually want this tool to place orders
      later in Part 4). Withdrawal permission should stay OFF no matter what.
   4. Cloudflare Workers do not have a fixed outbound IP, so exchange IP-whitelisting
      cannot be used reliably with this setup. If your exchange requires IP whitelist
      for API keys, this Worker won't work for that key — you'd need a host with a
      static IP instead (e.g. Render or a small VPS). Keys without IP whitelist work fine.
------------------------------------------------------------- */

async function handleConnect(request, env, headers) {
  const { userId, exchange, apiKey, apiSecret, passphrase } = await request.json();
  if (!userId || !exchange || !apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: "Missing fields" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  const record = { apiKey, apiSecret, passphrase: passphrase || null, connectedAt: Date.now() };
  await env.ACCOUNTS_KV.put(`acct:${userId}:${exchange}`, JSON.stringify(record));
  return new Response(JSON.stringify({ ok: true, exchange }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function handleDisconnect(request, env, headers) {
  const { userId, exchange } = await request.json();
  await env.ACCOUNTS_KV.delete(`acct:${userId}:${exchange}`);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function handleAccount(request, env, headers) {
  const { userId, exchange } = await request.json();
  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) {
    return new Response(JSON.stringify({ connected: false }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  const creds = JSON.parse(raw);
  try {
    let balances;
    if (exchange === "binance") balances = await getBinanceBalance(creds);
    else if (exchange === "bybit") balances = await getBybitBalance(creds);
    else if (exchange === "okx") balances = await getOkxBalance(creds);
    else if (exchange === "kucoin") balances = await getKucoinBalance(creds);
    else throw new Error("Unsupported exchange");

    return new Response(JSON.stringify({ connected: true, exchange, balances }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ connected: true, exchange, error: err.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

/* ---- crypto helpers (Web Crypto API, available natively in Workers) ---- */
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacBase64(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/* ---- Binance: GET /api/v3/account (signed) ---- */
async function getBinanceBalance(creds) {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const sig = await hmacHex(creds.apiSecret, query);
  const r = await fetch(`https://api.binance.com/api/v3/account?${query}&signature=${sig}`, {
    headers: { "X-MBX-APIKEY": creds.apiKey },
  });
  const d = await r.json();
  if (d.code) throw new Error(d.msg || "Binance error");
  return (d.balances || [])
    .filter((b) => parseFloat(b.free) + parseFloat(b.locked) > 0)
    .map((b) => ({ asset: b.asset, free: b.free, locked: b.locked }));
}

/* ---- Bybit v5: GET /v5/account/wallet-balance ---- */
async function getBybitBalance(creds) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const query = "accountType=UNIFIED";
  const signPayload = timestamp + creds.apiKey + recvWindow + query;
  const sig = await hmacHex(creds.apiSecret, signPayload);
  const r = await fetch(`https://api.bybit.com/v5/account/wallet-balance?${query}`, {
    headers: {
      "X-BAPI-API-KEY": creds.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sig,
    },
  });
  const d = await r.json();
  if (d.retCode !== 0) throw new Error(d.retMsg || "Bybit error");
  const coins = d.result?.list?.[0]?.coin || [];
  return coins
    .filter((c) => parseFloat(c.walletBalance) > 0)
    .map((c) => ({ asset: c.coin, free: c.availableToWithdraw || c.walletBalance, locked: "0" }));
}

/* ---- OKX: GET /api/v5/account/balance ---- */
async function getOkxBalance(creds) {
  if (!creds.passphrase) throw new Error("OKX requires a passphrase");
  const timestamp = new Date().toISOString();
  const method = "GET";
  const path = "/api/v5/account/balance";
  const sig = await hmacBase64(creds.apiSecret, timestamp + method + path);
  const r = await fetch("https://www.okx.com" + path, {
    headers: {
      "OK-ACCESS-KEY": creds.apiKey,
      "OK-ACCESS-SIGN": sig,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": creds.passphrase,
    },
  });
  const d = await r.json();
  if (d.code !== "0") throw new Error(d.msg || "OKX error");
  const details = d.data?.[0]?.details || [];
  return details
    .filter((b) => parseFloat(b.cashBal) > 0)
    .map((b) => ({ asset: b.ccy, free: b.availBal, locked: b.frozenBal }));
}

/* ---- KuCoin: GET /api/v1/accounts ---- */
async function getKucoinBalance(creds) {
  if (!creds.passphrase) throw new Error("KuCoin requires a passphrase");
  const timestamp = Date.now().toString();
  const method = "GET";
  const path = "/api/v1/accounts";
  const sig = await hmacBase64(creds.apiSecret, timestamp + method + path);
  const signedPassphrase = await hmacBase64(creds.apiSecret, creds.passphrase);
  const r = await fetch("https://api.kucoin.com" + path, {
    headers: {
      "KC-API-KEY": creds.apiKey,
      "KC-API-SIGN": sig,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": signedPassphrase,
      "KC-API-KEY-VERSION": "2",
    },
  });
  const d = await r.json();
  if (d.code !== "200000") throw new Error(d.msg || "KuCoin error");
  return (d.data || [])
    .filter((b) => parseFloat(b.balance) > 0)
    .map((b) => ({ asset: b.currency, free: b.available, locked: b.holds }));
}
/* ---------------- Real Order Placement (Part 4) ----------------
   SAFETY: every order is a MARKET order sized in USD (quote currency),
   capped server-side by MAX_ORDER_USD so a frontend bug or mistake can
   never send an order larger than you've explicitly allowed.

   Set MAX_ORDER_USD as a plain (non-secret) variable in worker Settings,
   e.g. 50. If not set, it defaults to 25.
------------------------------------------------------------- */
async function handleOrder(request, env, headers) {
  const { userId, exchange, symbol, side, usdAmount, confirm } = await request.json();
  if (!userId || !exchange || !symbol || !side || !usdAmount) {
    return new Response(JSON.stringify({ error: "Missing fields" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  if (confirm !== true) {
    return new Response(JSON.stringify({ error: "Order not confirmed" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  const maxUsd = parseFloat(env.MAX_ORDER_USD || "25");
  if (parseFloat(usdAmount) > maxUsd) {
    return new Response(
      JSON.stringify({ error: `Order exceeds max allowed size of $${maxUsd}. Raise MAX_ORDER_USD in worker settings if intentional.` }),
      { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
  if (side !== "buy" && side !== "sell") {
    return new Response(JSON.stringify({ error: "side must be buy or sell" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const raw = await env.ACCOUNTS_KV.get(`acct:${userId}:${exchange}`);
  if (!raw) {
    return new Response(JSON.stringify({ error: "Exchange not connected" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  const creds = JSON.parse(raw);

  try {
    let result;
    if (exchange === "binance") result = await placeBinanceOrder(creds, symbol, side, usdAmount);
    else if (exchange === "bybit") result = await placeBybitOrder(creds, symbol, side, usdAmount);
    else if (exchange === "okx") result = await placeOkxOrder(creds, symbol, side, usdAmount);
    else if (exchange === "kucoin") result = await placeKucoinOrder(creds, symbol, side, usdAmount);
    else throw new Error("Unsupported exchange");

    return new Response(JSON.stringify({ ok: true, exchange, result }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

/* ---- Binance: POST /api/v3/order (MARKET, quoteOrderQty in USDT) ---- */
async function placeBinanceOrder(creds, symbol, side, usdAmount) {
  const timestamp = Date.now();
  const params = `symbol=${symbol}&side=${side.toUpperCase()}&type=MARKET&quoteOrderQty=${usdAmount}&timestamp=${timestamp}&recvWindow=5000`;
  const sig = await hmacHex(creds.apiSecret, params);
  const r = await fetch(`https://api.binance.com/api/v3/order?${params}&signature=${sig}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": creds.apiKey },
  });
  const d = await r.json();
  if (d.code) throw new Error(d.msg || "Binance order failed");
  return d;
}

/* ---- Bybit v5: POST /v5/order/create (spot, market, qty in quote via marketUnit) ---- */
async function placeBybitOrder(creds, symbol, side, usdAmount) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const body = JSON.stringify({
    category: "spot",
    symbol,
    side: side === "buy" ? "Buy" : "Sell",
    orderType: "Market",
    qty: String(usdAmount),
    marketUnit: "quoteCoin",
  });
  const signPayload = timestamp + creds.apiKey + recvWindow + body;
  const sig = await hmacHex(creds.apiSecret, signPayload);
  const r = await fetch("https://api.bybit.com/v5/order/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": creds.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": sig,
    },
    body,
  });
  const d = await r.json();
  if (d.retCode !== 0) throw new Error(d.retMsg || "Bybit order failed");
  return d.result;
}

/* ---- OKX: POST /api/v5/trade/order (cash, market, sz in quote ccy for buy) ---- */
async function placeOkxOrder(creds, symbol, side, usdAmount) {
  if (!creds.passphrase) throw new Error("OKX requires a passphrase");
  const instId = symbol.replace(/(USDT)$/, "-USDT");
  const timestamp = new Date().toISOString();
  const method = "POST";
  const path = "/api/v5/trade/order";
  const bodyObj = {
    instId,
    tdMode: "cash",
    side,
    ordType: "market",
    sz: String(usdAmount),
    tgtCcy: side === "buy" ? "quote_ccy" : "base_ccy",
  };
  const body = JSON.stringify(bodyObj);
  const sig = await hmacBase64(creds.apiSecret, timestamp + method + path + body);
  const r = await fetch("https://www.okx.com" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": creds.apiKey,
      "OK-ACCESS-SIGN": sig,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": creds.passphrase,
    },
    body,
  });
  const d = await r.json();
  if (d.code !== "0") throw new Error(d.data?.[0]?.sMsg || d.msg || "OKX order failed");
  return d.data;
}

/* ---- KuCoin: POST /api/v1/orders (market, funds in quote ccy for buy) ---- */
async function placeKucoinOrder(creds, symbol, side, usdAmount) {
  if (!creds.passphrase) throw new Error("KuCoin requires a passphrase");
  const kcSymbol = symbol.replace(/(USDT)$/, "-USDT");
  const timestamp = Date.now().toString();
  const method = "POST";
  const path = "/api/v1/orders";
  const bodyObj = {
    clientOid: crypto.randomUUID(),
    side,
    symbol: kcSymbol,
    type: "market",
  };
  if (side === "buy") {
    bodyObj.funds = String(usdAmount);
  } else {
    const tickerResp = await fetch(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${kcSymbol}`);
    const tickerData = await tickerResp.json();
    const price = parseFloat(tickerData.data?.price || "0");
    if (!price) throw new Error("Could not fetch price for sell sizing");
    bodyObj.size = (parseFloat(usdAmount) / price).toFixed(6);
  }
  const body = JSON.stringify(bodyObj);
  const sig = await hmacBase64(creds.apiSecret, timestamp + method + path + body);
  const signedPassphrase = await hmacBase64(creds.apiSecret, creds.passphrase);
  const r = await fetch("https://api.kucoin.com" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "KC-API-KEY": creds.apiKey,
      "KC-API-SIGN": sig,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": signedPassphrase,
      "KC-API-KEY-VERSION": "2",
    },
    body,
  });
  const d = await r.json();
  if (d.code !== "200000") throw new Error(d.msg || "KuCoin order failed");
  return d.data;
}

async function handleNews(url, env, headers) {
  const query = url.searchParams.get("q") || "cryptocurrency";
  const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(
    query
  )}&language=en&sortBy=publishedAt&pageSize=12&apiKey=${env.NEWS_API_KEY}`;

  const resp = await fetch(newsUrl, {
    headers: { "User-Agent": "CryptoMindPro/1.0" },
  });

  if (!resp.ok) {
    // Fallback: CryptoCompare news (no key required) if NewsAPI fails
    const fallback = await fetch(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN"
    );
    const fbData = await fallback.json();
    const articles = (fbData.Data || []).slice(0, 12).map((a) => ({
      title: a.title,
      url: a.url,
      source: a.source,
      publishedAt: new Date(a.published_on * 1000).toISOString(),
    }));
    return new Response(JSON.stringify({ articles, source: "cryptocompare-fallback" }), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const data = await resp.json();
  const articles = (data.articles || []).map((a) => ({
    title: a.title,
    url: a.url,
    source: a.source?.name,
    publishedAt: a.publishedAt,
  }));

  return new Response(JSON.stringify({ articles, source: "newsapi" }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
