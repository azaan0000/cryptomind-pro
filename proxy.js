const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;

// Health ping check
app.get('/fapi/v1/ping', (req, res) => {
  res.status(200).json({});
});

// Proxy handler for Binance
app.use('/', createProxyMiddleware({
  target: 'https://fapi.binance.com',
  changeOrigin: true,
  secure: true,
  onProxyReq: (proxyReq, req) => {
    // 1. Force real Browser User-Agent so Binance Firewall NEVER blocks it
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    proxyReq.setHeader('Accept', 'application/json');

    // 2. Forward Binance API Key if present
    if (req.headers['x-mbx-apikey']) {
      proxyReq.setHeader('X-MBX-APIKEY', req.headers['x-mbx-apikey']);
    }
  },
  onProxyRes: (proxyRes) => {
    // Enable CORS
    proxyRes.headers['access-control-allow-origin'] = '*';
    proxyRes.headers['access-control-allow-headers'] = '*';
    proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
}));

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
