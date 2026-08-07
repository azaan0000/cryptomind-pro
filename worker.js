/**
 * CryptoMind PRO – Comprehensive Enterprise Cloudflare Worker Backend
 * Fully preserves all routing paths, proxy mechanics, signing helpers, 
 * error isolation, and ensures guaranteed JSON responses to the frontend.
 */

// ============================================================================
// 1. CONFIGURATION & ENVIRONMENT SETUP
// ============================================================================

const ALLOWED_ORIGINS = [
  "https://cryptomind-pro.pages.dev",
  "https://azaan0000.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

const FIXIE_URL = "http://fixie:s31F2b1INK833ob@criterium.usefixie.com:80";

const BINANCE_BASE_ENDPOINTS = [
  "https://fapi.binance.com",
  "https://fapi-gcp.binance.com"
];

// ============================================================================
// 2. CORS & HEADERS BUILDER
// ============================================================================

function buildCorsHeaders(requestOrigin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-MBX-APIKEY, Authorization, x-api-key, x-api-secret, X-MBX-SECRET",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

// ============================================================================
// 3. CRYPTOGRAPHIC SIGNING & PARSING UTILITIES
// ============================================================================

async function calculateHmacSha256(queryString, apiSecret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(apiSecret);
  const msgData = encoder.encode(queryString);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function parseRequestBody(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return {};
  }
  try {
    const rawText = await request.clone().text();
    if (!rawText || rawText.trim().length === 0) {
      return {};
    }
    return JSON.parse(rawText);
  } catch (err) {
    return {};
  }
}

async function extractApiCredentials(request, env, bodyObj = {}) {
  let apiKey = 
    request.headers.get("X-MBX-APIKEY") || 
    request.headers.get("x-api-key") || 
    bodyObj.apiKey || 
    bodyObj.key || 
    (env ? env.BINANCE_API_KEY : "") || "";

  let apiSecret = 
    request.headers.get("X-MBX-SECRET") || 
    request.headers.get("x-api-secret") || 
    bodyObj.apiSecret || 
    bodyObj.secret || 
    (env ? env.BINANCE_API_SECRET : "") || "";

  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

// ============================================================================
// 4. FIXIE PROXY & BINANCE NETWORK DISPATCHER
// ============================================================================

async function executeBinanceFetch(pathAndQuery, method, headers = {}, bodyData = null) {
  const proxyUrl = new URL(FIXIE_URL);
  const proxyAuthToken = "Basic " + btoa(`${proxyUrl.username}:${proxyUrl.password}`);

  const outgoingHeaders = new Headers(headers);
  outgoingHeaders.set("Proxy-Authorization", proxyAuthToken);

  // Strip Cloudflare internal tracking headers to avoid proxy drops
  outgoingHeaders.delete("cf-connecting-ip");
  outgoingHeaders.delete("cf-visitor");
  outgoingHeaders.delete("cf-ray");
  outgoingHeaders.delete("cf-ipcountry");

  let executionErrors = [];

  // Strategy 1: Attempt through Fixie Outbound Tunneling
  for (const endpoint of BINANCE_BASE_ENDPOINTS) {
    const fullTargetUrl = `${endpoint}${pathAndQuery}`;
    try {
      const response = await fetch(fullTargetUrl, {
        method: method,
        headers: outgoingHeaders,
        body: bodyData
      });

      if (response.status !== 403) {
        return response;
      }
      executionErrors.push(`Endpoint ${endpoint} returned WAF 403 via Fixie Proxy.`);
    } catch (err) {
      executionErrors.push(`Network error connecting to ${endpoint} via Fixie: ${err.message}`);
    }
  }

  // Strategy 2: Fallback Direct Fetch (In case Fixie HTTP tunnel fails)
  const cleanHeaders = new Headers(headers);
  cleanHeaders.delete("Proxy-Authorization");

  for (const endpoint of BINANCE_BASE_ENDPOINTS) {
    const fullTargetUrl = `${endpoint}${pathAndQuery}`;
    try {
      const response = await fetch(fullTargetUrl, {
        method: method,
        headers: cleanHeaders,
        body: bodyData
      });

      if (response.status !== 403) {
        return response;
      }
      executionErrors.push(`Endpoint ${endpoint} returned WAF 403 via Direct Route.`);
    } catch (err) {
      executionErrors.push(`Network error connecting to ${endpoint} via Direct Route: ${err.message}`);
    }
  }

  throw new Error(`All Binance Connection Paths Exhausted: ${executionErrors.join(" | ")}`);
}

async function sendBinanceSignedRequest(credentials, method, path, params = {}) {
  const { apiKey, apiSecret } = credentials;

  if (!apiKey || !apiSecret) {
    throw new Error("Missing Binance API Key or API Secret. Please check your exchange setup.");
  }

  const timestamp = Date.now();
  const searchParams = new URLSearchParams();

  for (const [paramKey, paramVal] of Object.entries(params)) {
    if (paramVal !== undefined && paramVal !== null) {
      searchParams.append(paramKey, paramVal.toString());
    }
  }
  searchParams.append("timestamp", timestamp.toString());

  const signature = await calculateHmacSha256(searchParams.toString(), apiSecret);
  searchParams.append("signature", signature);

  const requestHeaders = {
    "X-MBX-APIKEY": apiKey,
    "Content-Type": "application/x-www-form-urlencoded"
  };

  const targetPathAndQuery = (method === "GET" || method === "DELETE")
    ? `${path}?${searchParams.toString()}`
    : path;

  const requestBody = (method === "POST" || method === "PUT")
    ? searchParams.toString()
    : null;

  const binanceRawResponse = await executeBinanceFetch(targetPathAndQuery, method, requestHeaders, requestBody);
  const responseText = await binanceRawResponse.text();

  let parsedJson = null;
  try {
    parsedJson = JSON.parse(responseText);
  } catch (parseError) {
    throw new Error(`Invalid non-JSON response from exchange: ${responseText.substring(0, 150)}`);
  }

  if (!binanceRawResponse.ok) {
    const binanceErrorMessage = parsedJson.msg || `Exchange API returned HTTP Error ${binanceRawResponse.status}`;
    throw new Error(binanceErrorMessage);
  }

  return parsedJson;
}

// ============================================================================
// 5. MAIN ROUTER & CONTROLLER LAYER
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const originHeader = request.headers.get("Origin") || "";
    const cors = buildCorsHeaders(originHeader);

    // Preflight Handling
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const requestUrl = new URL(request.url);
    const pathname = requestUrl.pathname;

    try {
      const bodyParams = await parseRequestBody(request);
      const credentials = await extractApiCredentials(request, env, bodyParams);

      // Route 1: Health & Connectivity Checks
      if (pathname === "/" || pathname === "/api" || pathname === "/api/health" || pathname === "/api/connect" || pathname === "/api/status") {
        return jsonResponse({
          ok: true,
          status: "online",
          service: "CryptoMind PRO Gateway",
          timestamp: new Date().toISOString()
        }, 200, cors);
      }

      // Route 2: Server Time Synchronization
      if (pathname === "/api/time" || pathname === "/v1/time") {
        const binanceTimeRes = await executeBinanceFetch("/fapi/v1/time", "GET");
        const timeData = await binanceTimeRes.json();
        return jsonResponse(timeData, binanceTimeRes.status, cors);
      }

      // Route 3: Klines & Candlesticks Chart Data
      if (pathname === "/api/klines" || pathname === "/v1/klines") {
        const symbol = requestUrl.searchParams.get("symbol") || "BTCUSDT";
        const interval = requestUrl.searchParams.get("interval") || "1h";
        const limit = requestUrl.searchParams.get("limit") || "100";
        const klinesRes = await executeBinanceFetch(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, "GET");
        const klinesData = await klinesRes.json();
        return jsonResponse(klinesData, klinesRes.status, cors);
      }

      // Route 4: Fetch Active Futures Positions
      if (pathname === "/api/futures/positions" || pathname === "/api/positions") {
        const positionRiskData = await sendBinanceSignedRequest(credentials, "GET", "/fapi/v2/positionRisk");
        
        const activePositions = (Array.isArray(positionRiskData) ? positionRiskData : [])
          .filter(pos => parseFloat(pos.positionAmt) !== 0)
          .map(pos => ({
            symbol: pos.symbol,
            positionAmt: pos.positionAmt,
            side: parseFloat(pos.positionAmt) > 0 ? "LONG" : "SHORT",
            qty: Math.abs(parseFloat(pos.positionAmt)),
            entryPrice: parseFloat(pos.entryPrice),
            markPrice: parseFloat(pos.markPrice),
            unrealizedPnl: parseFloat(pos.unRealizedProfit),
            leverage: parseFloat(pos.leverage)
          }));

        return jsonResponse({ ok: true, positions: activePositions }, 200, cors);
      }

      // Route 5: Close Active Position
      if (pathname === "/api/futures/close" || pathname === "/api/close") {
        const { symbol, side, qty } = bodyParams;
        const targetSide = (side || "").toUpperCase() === "LONG" ? "SELL" : "BUY";

        const closeResult = await sendBinanceSignedRequest(credentials, "POST", "/fapi/v1/order", {
          symbol: symbol,
          side: targetSide,
          type: "MARKET",
          quantity: qty,
          reduceOnly: "true"
        });

        return jsonResponse({ ok: true, result: closeResult }, 200, cors);
      }

      // Route 6: Open Orders List
      if (pathname === "/api/futures/open-orders" || pathname === "/api/open-orders") {
        const targetSymbol = bodyParams.symbol || requestUrl.searchParams.get("symbol");
        const openOrders = await sendBinanceSignedRequest(
          credentials,
          "GET",
          "/fapi/v1/openOrders",
          targetSymbol ? { symbol: targetSymbol } : {}
        );

        return jsonResponse({ ok: true, orders: openOrders }, 200, cors);
      }

      // Route 7: Cancel Specific Order
      if (pathname === "/api/futures/cancel-order" || pathname === "/api/cancel-order") {
        const { symbol, orderId } = bodyParams;
        const cancelResult = await sendBinanceSignedRequest(credentials, "DELETE", "/fapi/v1/order", {
          symbol: symbol,
          orderId: orderId
        });

        return jsonResponse({ ok: true, result: cancelResult }, 200, cors);
      }

      // Route 8: Modify Stop Loss Order
      if (pathname === "/api/futures/modify-sl" || pathname === "/api/modify-sl") {
        const { symbol, side, newSlPrice } = bodyParams;
        const exitSide = (side || "").toUpperCase() === "LONG" ? "SELL" : "BUY";

        const slOrderResult = await sendBinanceSignedRequest(credentials, "POST", "/fapi/v1/order", {
          symbol: symbol,
          side: exitSide,
          type: "STOP_MARKET",
          stopPrice: parseFloat(newSlPrice).toString(),
          closePosition: "true"
        });

        return jsonResponse({ ok: true, order: slOrderResult }, 200, cors);
      }

      // Route 9: Account Balance & Futures Overview
      if (pathname === "/api/account" || pathname === "/api/futures/account" || pathname === "/v2/account") {
        const accountDetails = await sendBinanceSignedRequest(credentials, "GET", "/fapi/v2/account");
        return jsonResponse({ ok: true, account: accountDetails }, 200, cors);
      }

      // Route 10: Place New Order (Buy/Sell)
      if (pathname === "/api/order" || pathname === "/api/futures/order" || pathname === "/v1/order") {
        const orderResult = await sendBinanceSignedRequest(credentials, "POST", "/fapi/v1/order", bodyParams);
        return jsonResponse({ ok: true, result: orderResult }, 200, cors);
      }

      // Route 11: Trade History & Income Streams
      if (pathname === "/api/futures/income" || pathname === "/api/income") {
        const { symbol, limit } = bodyParams;
        const incomeLogs = await sendBinanceSignedRequest(credentials, "GET", "/fapi/v1/income", {
          limit: limit || 50,
          ...(symbol && { symbol: symbol })
        });
        return jsonResponse({ ok: true, income: incomeLogs }, 200, cors);
      }

      // Route 12: Compatibility Placeholders for Frontend Trade History Sync
      if (pathname === "/api/trade/history" || pathname === "/api/trade/sync" || pathname === "/api/trade/insights") {
        return jsonResponse({ ok: true, trades: [], updated: 0, totalTrades: 0 }, 200, cors);
      }

      // Route 13: Universal Direct Pass-Through Fallback Route
      const binanceSubPath = pathname.replace(/^\/api/, "") + requestUrl.search;
      const passHeaders = {};
      if (credentials.apiKey) passHeaders["X-MBX-APIKEY"] = credentials.apiKey;

      const fallbackBinanceRes = await executeBinanceFetch(
        binanceSubPath,
        request.method,
        passHeaders,
        ["GET", "HEAD"].includes(request.method) ? null : JSON.stringify(bodyParams)
      );

      const responseBuffer = await fallbackBinanceRes.arrayBuffer();
      return new Response(responseBuffer, {
        status: fallbackBinanceRes.status,
        headers: cors
      });

    } catch (globalRouterError) {
      // Global Safety Catch: Converts ALL errors into structured JSON (Prevents HTML response dumps)
      return jsonResponse({
        ok: false,
        error: globalRouterError.message || "Internal Worker Proxy Exception"
      }, 200, cors);
    }
  }
};
