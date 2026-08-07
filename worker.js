/**
 * CryptoMind PRO – Enterprise Cloudflare Worker Backend
 * Complete Native Implementation without Node/Express dependencies
 */

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
    if (!rawText || rawText.trim().length === 0) return {};
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
    (env ? env.BINANCE_API_KEY : "") || "";

  let apiSecret = 
    request.headers.get("X-MBX-SECRET") || 
    request.headers.get("x-api-secret") || 
    bodyObj.apiSecret || 
    (env ? env.BINANCE_API_SECRET : "") || "";

  return { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
}

async function executeBinanceFetch(pathAndQuery, method, headers = {}, bodyData = null) {
  const proxyUrl = new URL(FIXIE_URL);
  const proxyAuthToken = "Basic " + btoa(`${proxyUrl.username}:${proxyUrl.password}`);

  const outgoingHeaders = new Headers(headers);
  outgoingHeaders.set("Proxy-Authorization", proxyAuthToken);
  outgoingHeaders.delete("cf-connecting-ip");
  outgoingHeaders.delete("cf-visitor");
  outgoingHeaders.delete("cf-ray");
  outgoingHeaders.delete("cf-ipcountry");

  let executionErrors = [];

  for (const endpoint of BINANCE_BASE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}${pathAndQuery}`, {
        method: method,
        headers: outgoingHeaders,
        body: bodyData
      });

      if (response.status !== 403) return response;
      executionErrors.push(`403 from ${endpoint}`);
    } catch (err) {
      executionErrors.push(err.message);
    }
  }

  const cleanHeaders = new Headers(headers);
  cleanHeaders.delete("Proxy-Authorization");

  for (const endpoint of BINANCE_BASE_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}${pathAndQuery}`, {
        method: method,
        headers: cleanHeaders,
        body: bodyData
      });

      if (response.status !== 403) return response;
    } catch (err) {
      executionErrors.push(err.message);
    }
  }

  throw new Error(`Binance Connection Error: ${executionErrors.join(" | ")}`);
}

async function sendBinanceSignedRequest(credentials, method, path, params = {}) {
  const { apiKey, apiSecret } = credentials;
  if (!apiKey || !apiSecret) {
    throw new Error("Missing Binance API Key or Secret");
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
    throw new Error(`Invalid non-JSON response: ${responseText.substring(0, 100)}`);
  }

  if (!binanceRawResponse.ok) {
    throw new Error(parsedJson.msg || `Error ${binanceRawResponse.status}`);
  }

  return parsedJson;
}

export default {
  async fetch(request, env, ctx) {
    const originHeader = request.headers.get("Origin") || "";
    const cors = buildCorsHeaders(originHeader);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const requestUrl = new URL(request.url);
    const pathname = requestUrl.pathname;

    try {
      const bodyParams = await parseRequestBody(request);
      const credentials = await extractApiCredentials(request, env, bodyParams);

      if (pathname === "/" || pathname === "/api" || pathname === "/api/health" || pathname === "/api/connect") {
        return jsonResponse({ ok: true, status: "online", message: "CryptoMind PRO Gateway Active" }, 200, cors);
      }

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

      if (pathname === "/api/account" || pathname === "/api/futures/account") {
        const accountDetails = await sendBinanceSignedRequest(credentials, "GET", "/fapi/v2/account");
        return jsonResponse({ ok: true, account: accountDetails }, 200, cors);
      }

      if (pathname === "/api/order" || pathname === "/api/futures/order") {
        const orderResult = await sendBinanceSignedRequest(credentials, "POST", "/fapi/v1/order", bodyParams);
        return jsonResponse({ ok: true, result: orderResult }, 200, cors);
      }

      return jsonResponse({ ok: false, error: `Route '${pathname}' not found` }, 404, cors);

    } catch (globalRouterError) {
      return jsonResponse({ ok: false, error: globalRouterError.message || "Internal Worker Error" }, 200, cors);
    }
  }
};
