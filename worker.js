/**
 * CryptoMind PRO - Cloudflare Worker
 * Updated with Fixie Outbound Credentials & Binance GCP Proxy Fallback
 */

const ALLOWED_ORIGINS = [
  "https://cryptomind-pro.pages.dev",
  "https://azaan0000.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

// Fixie Outbound Proxy Details
const FIXIE_URL = "http://fixie:s31F2b1INK833ob@criterium.usefixie.com:80";

// Binance Futures Endpoints (Primary & GCP Fallback)
const BINANCE_BASE_ENDPOINTS = [
  "https://fapi.binance.com",
  "https://fapi-gcp.binance.com"
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MBX-APIKEY, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

// ---------------------------------------------------------------------------
// Core Binance Signed Request Handler (Fixie + GCP Fallback)
// ---------------------------------------------------------------------------
async function futuresSignedRequest(creds, method, path, params = {}) {
  const { apiKey, apiSecret } = creds;
  if (!apiKey || !apiSecret) {
    throw new Error("Missing API Key or API Secret");
  }

  const timestamp = Date.now();
  const searchParams = new URLSearchParams({ ...params, timestamp });

  // Generate HMAC SHA-256 Signature
  const encoder = new TextEncoder();
  const keyData = encoder.encode(apiSecret);
  const msgData = encoder.encode(searchParams.toString());

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const signature = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  searchParams.append("signature", signature);

  // Fixie Authorization Header
  const proxyUrl = new URL(FIXIE_URL);
  const proxyAuth = "Basic " + btoa(`${proxyUrl.username}:${proxyUrl.password}`);

  let lastError = null;
  let response = null;

  for (const baseUrl of BINANCE_BASE_ENDPOINTS) {
    const fullUrl = method === "GET" || method === "DELETE"
      ? `${baseUrl}${path}?${searchParams.toString()}`
      : `${baseUrl}${path}`;

    const headers = {
      "X-MBX-APIKEY": apiKey,
      "Proxy-Authorization": proxyAuth,
      "Content-Type": "application/x-www-form-urlencoded"
    };

    try {
      response = await fetch(fullUrl, {
        method,
        headers,
        body: method === "POST" || method === "PUT" ? searchParams.toString() : null
      });

      if (response.status !== 403) {
        break; // Request successful or standard API error (not WAF IP block)
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!response) {
    throw new Error(lastError ? lastError.toString() : "Unable to reach Binance API via proxy routes.");
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.msg || `Binance API Error: ${response.status}`);
  }

  return data;
}

// Helper to extract API credentials
async function getCreds(env, userId, exchange) {
  if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) {
    return { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET };
  }
  throw new Error("API Credentials not found in environment settings.");
}

// ---------------------------------------------------------------------------
// Worker Main Fetch Router & Handlers
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/futures/positions") {
        return await handleFuturesPositions(request, env, headers);
      }
      if (path === "/api/futures/close") {
        return await handleFuturesClose(request, env, headers);
      }
      if (path === "/api/futures/open-orders") {
        return await handleFuturesOpenOrders(request, env, headers);
      }
      if (path === "/api/futures/cancel-order") {
        return await handleFuturesCancelOrder(request, env, headers);
      }
      if (path === "/api/futures/modify-sl") {
        return await handleFuturesModifySL(request, env, headers);
      }
      if (path === "/api/futures/income") {
        return await handleFuturesIncome(request, env, headers);
      }
      if (path === "/api/trade/history") {
        return await handleTradeHistory(request, env, headers);
      }
      if (path === "/api/trade/sync") {
        return await handleTradeSync(request, env, headers);
      }
      if (path === "/api/trade/insights") {
        return await handleTradeInsights(request, env, headers);
      }

      return new Response(JSON.stringify({ ok: false, error: "Route not found" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    } catch (globalErr) {
      return new Response(JSON.stringify({ ok: false, error: globalErr.message }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" }
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Endpoint Handlers
// ---------------------------------------------------------------------------
async function handleFuturesPositions(request, env, headers) {
  try {
    const { userId, exchange } = request.method === "POST" ? await request.json() : {};
    const creds = await getCreds(env, userId, exchange || "binance");
    const accountInfo = await futuresSignedRequest(creds, "GET", "/fapi/v2/positionRisk");
    
    const open = accountInfo
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        positionAmt: p.positionAmt,
        side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
        qty: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        leverage: parseFloat(p.leverage),
      }));

    return new Response(JSON.stringify({ ok: true, positions: open }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, positions: [] }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleFuturesClose(request, env, headers) {
  const { userId, exchange, symbol, side, qty } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const closeSide = side === "long" ? "SELL" : "BUY";
    const result = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", {
      symbol,
      side: closeSide,
      type: "MARKET",
      quantity: qty,
      reduceOnly: "true"
    });
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleFuturesOpenOrders(request, env, headers) {
  const { userId, exchange, symbol } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const orders = await futuresSignedRequest(creds, "GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
    return new Response(JSON.stringify({ ok: true, orders }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, orders: [] }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleFuturesCancelOrder(request, env, headers) {
  const { userId, exchange, symbol, orderId } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const result = await futuresSignedRequest(creds, "DELETE", "/fapi/v1/order", { symbol, orderId });
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleFuturesModifySL(request, env, headers) {
  const { userId, exchange, symbol, side, newSlPrice } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const exitSide = side === "long" ? "SELL" : "BUY";
    const newOrder = await futuresSignedRequest(creds, "POST", "/fapi/v1/order", {
      symbol,
      side: exitSide,
      type: "STOP_MARKET",
      stopPrice: parseFloat(newSlPrice).toString(),
      closePosition: "true"
    });
    return new Response(JSON.stringify({ ok: true, order: newOrder }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleFuturesIncome(request, env, headers) {
  const { userId, exchange, symbol, limit } = await request.json();
  try {
    const creds = await getCreds(env, userId, exchange || "binance");
    const income = await futuresSignedRequest(creds, "GET", "/fapi/v1/income", {
      limit: limit || 50,
      ...(symbol && { symbol })
    });
    return new Response(JSON.stringify({ ok: true, income }), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, income: [] }), {
      status: 502,
      headers: { ...headers, "Content-Type": "application/json" }
    });
  }
}

async function handleTradeHistory(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, trades: [] }), {
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

async function handleTradeSync(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, updated: 0 }), {
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

async function handleTradeInsights(request, env, headers) {
  return new Response(JSON.stringify({ ok: true, totalTrades: 0 }), {
    headers: { ...headers, "Content-Type": "application/json" }
  });
}
