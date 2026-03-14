/**
 * Authentication middleware for mcp-recall.
 *
 * Supports two modes (both optional, configured via env vars):
 *   - MCP_API_KEY:  Static Bearer token for CLI clients (Claude Code)
 *   - MCP_AUTH_PIN: OAuth 2.1 with PIN consent for web/mobile clients (claude.ai)
 *
 * If neither is set, all requests are allowed (local dev mode).
 */

import { OAuthServer } from 'mcp-oauth-server';
import { mcpAuthRouter, authenticateHandler, requireBearerAuth } from 'mcp-oauth-server';

const MCP_API_KEY = process.env.MCP_API_KEY;
const MCP_AUTH_PIN = process.env.MCP_AUTH_PIN;
const BASE_URL = process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

// Rate limiting for PIN attempts
const pinAttempts = new Map(); // ip -> { count, resetAt }
const PIN_MAX_ATTEMPTS = 5;
const PIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const PIN_DELAY_MS = 1000; // delay per failed attempt

function checkPinRateLimit(ip) {
  const now = Date.now();
  const entry = pinAttempts.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= PIN_MAX_ATTEMPTS) {
      return { blocked: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { blocked: false, delay: entry.count * PIN_DELAY_MS };
  }

  return { blocked: false, delay: 0 };
}

function recordPinFailure(ip) {
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, resetAt: now + PIN_WINDOW_MS };
  if (now >= entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + PIN_WINDOW_MS;
  } else {
    entry.count++;
  }
  pinAttempts.set(ip, entry);
}

function clearPinFailures(ip) {
  pinAttempts.delete(ip);
}

let oauthServer = null;

/**
 * Initialize OAuth server if MCP_AUTH_PIN is set.
 */
export function initAuth(app) {
  const authEnabled = MCP_API_KEY || MCP_AUTH_PIN;

  if (!authEnabled) {
    console.log('Auth: disabled (no MCP_API_KEY or MCP_AUTH_PIN set)');
    return;
  }

  if (MCP_API_KEY) {
    console.log('Auth: API key enabled (for CLI clients)');
  }

  if (MCP_AUTH_PIN) {
    console.log('Auth: OAuth 2.1 with PIN enabled (for web/mobile clients)');

    oauthServer = new OAuthServer({
      authorizationUrl: new URL(`${BASE_URL}/consent`),
      scopesSupported: ['mcp:tools'],
      accessTokenLifetime: 86400, // 24 hours
      refreshTokenLifetime: 2592000, // 30 days
      strictResource: false, // claude.ai doesn't always send resource indicator
    });

    // Build the authenticate handler once
    const confirmAuth = authenticateHandler({
      provider: oauthServer,
      getUser: () => 'owner',
      rateLimit: false, // we handle rate limiting ourselves
    });

    // Consent page — simple PIN form
    // MUST be registered BEFORE mcpAuthRouter to avoid route conflicts
    app.get('/consent', (req, res) => {
      const query = new URLSearchParams(req.query).toString();
      res.type('html').send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>mcp-recall — Authorize</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 1.4em; }
    input[type=password] { width: 100%; padding: 12px; font-size: 1.2em; letter-spacing: 0.3em;
      text-align: center; border: 2px solid #ccc; border-radius: 8px; margin: 16px 0; }
    input[type=password]:focus { border-color: #4a90d9; outline: none; }
    button { width: 100%; padding: 12px; font-size: 1em; background: #4a90d9; color: white;
      border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #357abd; }
    .info { color: #666; font-size: 0.85em; margin-top: 24px; }
  </style>
</head><body>
  <h1>mcp-recall</h1>
  <p>Enter your PIN to authorize this client.</p>
  <form method="POST" action="/confirm?${query}">
    <input type="password" name="pin" inputmode="numeric" pattern="[0-9]*"
      placeholder="PIN" autocomplete="off" autofocus required>
    <button type="submit">Authorize</button>
  </form>
  <p class="info">This grants access to your mcp-recall memory server.</p>
</body></html>`);
    });

    // PIN verification + OAuth consent confirmation
    // Uses app.use (not app.post) because authenticateHandler is a sub-router
    app.use('/confirm', async (req, res, next) => {
      if (req.method !== 'POST') return next();

      const ip = req.ip;
      const rateCheck = checkPinRateLimit(ip);

      if (rateCheck.blocked) {
        res.status(429).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Too many attempts</title>
<style>body{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;padding:0 20px;color:#333;}</style>
</head><body><h1>Too many attempts</h1><p>Try again in ${rateCheck.retryAfter} seconds.</p></body></html>`);
        return;
      }

      if (rateCheck.delay > 0) {
        await new Promise(r => setTimeout(r, rateCheck.delay));
      }

      const pin = req.body?.pin;
      if (pin !== MCP_AUTH_PIN) {
        recordPinFailure(ip);
        console.log(`Auth: invalid PIN attempt from ${ip}`);
        const query = new URLSearchParams(req.query).toString();
        res.status(403).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-recall — Invalid PIN</title>
<style>body{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;padding:0 20px;color:#333;}
input[type=password]{width:100%;padding:12px;font-size:1.2em;letter-spacing:0.3em;text-align:center;border:2px solid #d32f2f;border-radius:8px;margin:16px 0;}
button{width:100%;padding:12px;font-size:1em;background:#4a90d9;color:white;border:none;border-radius:8px;cursor:pointer;}
.error{color:#d32f2f;margin:8px 0;}</style>
</head><body><h1>mcp-recall</h1>
<p class="error">Invalid PIN. Please try again.</p>
<form method="POST" action="/confirm?${query}">
  <input type="password" name="pin" inputmode="numeric" pattern="[0-9]*" placeholder="PIN" autocomplete="off" autofocus required>
  <button type="submit">Authorize</button>
</form></body></html>`);
        return;
      }

      clearPinFailures(ip);
      console.log(`Auth: PIN accepted from ${ip}`);
      next();
    }, confirmAuth);

    // Mount OAuth routes AFTER consent routes to avoid conflicts
    app.use(mcpAuthRouter({
      provider: oauthServer,
      issuerUrl: new URL(BASE_URL),
      baseUrl: new URL(BASE_URL),
      resourceServerUrl: new URL(`${BASE_URL}/mcp`),
      scopesSupported: ['mcp:tools'],
    }));
  }
}

/**
 * Express middleware that checks auth on MCP endpoints.
 * Allows requests if:
 *   1. No auth configured (dev mode)
 *   2. Valid static API key in Authorization header
 *   3. Valid OAuth Bearer token
 */
export function authMiddleware() {
  if (!MCP_API_KEY && !MCP_AUTH_PIN) {
    return (_req, _res, next) => next();
  }

  const oauthMiddleware = oauthServer
    ? requireBearerAuth({ verifier: oauthServer, requiredScopes: ['mcp:tools'] })
    : null;

  return (req, res, next) => {
    const authHeader = req.headers.authorization;

    // Check static API key first
    if (MCP_API_KEY && authHeader === `Bearer ${MCP_API_KEY}`) {
      return next();
    }

    // Check OAuth token
    if (oauthMiddleware && authHeader?.startsWith('Bearer ')) {
      return oauthMiddleware(req, res, next);
    }

    // No valid auth
    res.status(401).json({ error: 'Unauthorized' });
  };
}
