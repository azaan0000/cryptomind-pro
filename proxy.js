const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;

// Health check endpoint (warmup ke liye)
app.get('/fapi/v1/ping', (req, res) => {
  res.status(200).json({});
});

// Binance Futures Proxy
app.use('/', createProxyMiddleware({
  target: 'https://fapi.binance.com',
  changeOrigin: true,
  secure: true,
  onProxyReq: (proxyReq, req) => {
    // Preserve Binance API Key Header
    if (req.headers['x-mbx-apikey']) {
      proxyReq.setHeader('X-MBX-APIKEY', req.headers['x-mbx-apikey']);
    }
  },
  onProxyRes: (proxyRes) => {
    // Enable CORS for Cloudflare Worker
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-headers'] = '*';
    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
}));

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
