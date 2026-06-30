/**
 * CryptoMind PRO — Cloudflare Worker Backend (FIXED)
 * ----------------------------------------------------
 * Handles:
 *   POST /ai-report   -> calls Anthropic API with ProTrader-AI system prompt
 *   GET  /news        -> crypto news (CryptoCompare primary, NewsAPI fallback)
 *   POST /connect, /disconnect, /account, /order -> exchange account mgmt (unchanged)
 *
 * REQUIRED SECRETS (Settings -> Variables -> add as "Secret"):
 *   ANTHROPIC_API_KEY = sk-ant-...
 *   NEWS_API_KEY      = (optional now — CryptoCompare needs no key)
 *
 * If AI report still fails after deploying this: your ANTHROPIC_API_KEY secret
 * is missing, expired, or was revoked. Go to console.anthropic.com -> API Keys,
 * generate a fresh key, and paste it into the worker's secret again.
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

/* ---------------- AI Report (Anthropic, ProTrader-AI persona) ---------------- */
const PROTRADER_SYSTEM_PROMPT = `You are "ProTrader-AI," an elite institutional-grade trading analyst with 15+ years
of experience in quantitative finance, price action, and risk management. You analyze the market data given to you
and respond like a top professional trader — no hype, no vague language, every number must be precise.

RULES YOU MUST FOLLOW:
1. State market structure / trend direction clearly (Bullish, Bearish, or Range-bound).
2. Use confluence between price action (support/resistance) and the indicators provided — never invent indicator
   values that were not given to you.
3. Risk management: any trade idea must respect a tight Stop Loss and a Risk:Reward of at least 1:1.5. Stop Loss
   and Take Profit must be realistic short-term levels (intraday/scalp distance based on the ATR-style volatility
   implied by the data given), NOT a price 1000+ points away from entry.
4. If the algorithmic signal is HOLD, explain what would need to change (price, RSI, MACD) to flip it to a clear
   BUY or SELL — do not invent a trade that isn't there.
5. Be concise: max 160 words, plain text, no markdown headers, no bullet symbols.
6. End with exactly one line: "Not financial advice."`;

async function handleAIReport(request, env, headers) {
  const body = await request.json();
  const { symbol, price, indicators, signal, timeframe } = body;

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY secret is not set on the worker. Add it in Settings -> Variables -> Secrets." }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }

  const userPrompt = `Symbol: ${symbol}
Timeframe: ${timeframe}
Current price: ${price}
EMA20: ${indicators.ema20}  EMA50: ${indicators.ema50}
RSI(14): ${indicators.rsi}
MACD histogram: ${indicators.macdHist}
VWAP: ${indicators.vwap}
Support: ${indicators.support}  Resistance: ${indicators.resistance}
Algorithmic signal: ${signal.label} (confidence ${signal.confidence}%)

Write the market report now, following the system rules exactly.`;

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        system: PROTRADER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Network error reaching Anthropic API", detail: e.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    return new Response(JSON.stringify({ error: "AI request failed (" + resp.status + ")", detail: errText }), {
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

/* ---------------- News ----------------
   CryptoCompare is primary because it needs NO API key and works reliably from
   server-side environments (NewsAPI's free tier blocks production/non-localhost
   requests, which is why news was failing before).
------------------------------------------------------------- */
async function handleNews(url, env, headers) {
  // Primary: CryptoCompare (no key required, server-to-server friendly)
  try {
    const resp = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", {
      headers: { "User-Agent": "CryptoMindPro/1.0" },
    });
    if (resp.ok) {
      const data = await resp.json();
      const articles = (data.Data || []).slice(0, 15).map((a) => ({
        title: a.title,
        url: a.url,
        source: a.source_info?.name || a.source || "CryptoCompare",
        publishedAt: new Date(a.published_on * 1000).toISOString(),
      }));
      if (articles.length) {
        return new Response(JSON.stringify({ articles }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }
  } catch (e) {
    // fall through to NewsAPI
  }

  // Fallback: NewsAPI (only works if key is set and not blocked by their free-tier policy)
  if (env.NEWS_API_KEY) {
    try {
      const query = url.searchParams.get("q") || "cryptocurrency";
      const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=en&sortBy=publishedAt&pageSize=12&apiKey=${env.NEWS_API_KEY}`;
      const resp = await fetch(newsUrl, { headers: { "User-Agent": "CryptoMindPro/1.0" } });
      if (resp.ok) {
        const data = await resp.json();
        const articles = (data.articles || []).map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source?.name || "",
          publishedAt: a.publishedAt,
        }));
        return new Response(JSON.stringify({ articles }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    } catch (e) {
      // fall through
    }
  }

  return new Response(JSON.stringify({ articles: [], error: "All news sources failed." }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

/* ---------------- Exchange Account Connection ---------------- */
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

/* ---- crypto helpers ---- */
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

/* ---------------- Real Order Placement ---------------- */
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
