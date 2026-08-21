/**
 * server.js — deployable backend: market data, alerts, news, payments,
 * and persistence writes — all in one small Node process, no framework
 * dependency beyond `stripe`.
 *
 * DEPLOY (Render.com free tier, ~3 minutes):
 *   1. Create a new GitHub repo, add all the backend files from this
 *      build: server.js, package.json, live-provider-adapter.js,
 *      economic-calendar-adapter.js, payments-adapter.js.
 *   2. On render.com: New -> Web Service -> connect the repo.
 *      Build command: npm install   Start command: node server.js
 *   3. In Render's dashboard, add environment variables:
 *      TWELVE_DATA_API_KEY     = twelvedata.com/pricing (free tier)
 *      FINNHUB_API_KEY         = finnhub.io/register (free tier, for real news)
 *      TELEGRAM_BOT_TOKEN      = from @BotFather (optional, for alerts)
 *      STRIPE_SECRET_KEY       = dashboard.stripe.com (optional, for payments)
 *      STRIPE_PRICE_ID         = your Pro plan's price_... id
 *      STRIPE_WEBHOOK_SECRET   = from the Stripe webhook you create
 *      SUPABASE_URL            = from your Supabase project settings
 *      SUPABASE_SERVICE_ROLE_KEY = Supabase Settings -> API -> service_role
 *                                  (NEVER the anon key here — this one
 *                                  bypasses Row Level Security, so it must
 *                                  only ever live on the backend)
 *      APP_URL                 = your deployed frontend's URL
 *      ALLOWED_ORIGIN          = same, for CORS
 *   4. Deploy. Paste the resulting URL into the dashboard's Settings.
 *
 * (Vercel/Fly/Railway/a VPS all work the same way — this is a plain
 * Node http server with no platform-specific code.)
 */
const http = require("http");
const { getQuote, getCandles, getMarketStatus, getSpread } = require("./live-provider-adapter");
const { getUpcomingHighImpactEvents, relevantEventFor } = require("./economic-calendar-adapter");
const { createCheckoutSession, verifyWebhookEvent, handleWebhookEvent } = require("./payments-adapter");

const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function updateProfile(userId, patch, byStripeCustomerId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase not configured on the backend");
  const filter = byStripeCustomerId
    ? `stripe_customer_id=eq.${byStripeCustomerId}`
    : `id=eq.${userId}`;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Supabase profile update failed: ${res.status}`);
}

const lastSentByChat = new Map();
const ALERT_COOLDOWN_MS = 4 * 60 * 1000;

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured on the backend");
  const last = lastSentByChat.get(chatId) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) {
    return { skipped: true, reason: "cooldown" };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Telegram send failed");
  lastSentByChat.set(chatId, Date.now());
  return { skipped: false };
}

const buckets = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip) || { count: 0, windowStart: now };
  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count++;
  buckets.set(ip, bucket);
  return bucket.count > RATE_LIMIT;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, { error: "Rate limit exceeded — try again shortly" });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] !== "api") return send(res, 404, { error: "Not found" });

    if (parts[1] === "status") {
      return send(res, 200, getMarketStatus());
    }

    if (parts[1] === "quote" && parts[2]) {
      const symbol = decodeURIComponent(parts[2]);
      const quote = await getQuote(symbol);
      return send(res, 200, quote);
    }

    if (parts[1] === "candles" && parts[2] && parts[3]) {
      const symbol = decodeURIComponent(parts[2]);
      const timeframe = decodeURIComponent(parts[3]);
      const limit = Number(url.searchParams.get("limit")) || 140;
      const candles = await getCandles(symbol, timeframe, limit);
      return send(res, 200, { symbol, timeframe, candles });
    }

    if (parts[1] === "spread" && parts[2]) {
      const symbol = decodeURIComponent(parts[2]);
      const spreadPips = await getSpread(symbol);
      return send(res, 200, { symbol, spreadPips });
    }

    if (parts[1] === "news" && parts[2]) {
      const symbol = decodeURIComponent(parts[2]);
      const events = await getUpcomingHighImpactEvents(24);
      const relevant = relevantEventFor(symbol, events, 120);
      return send(res, 200, { symbol, upcoming: events.slice(0, 10), relevantEvent: relevant });
    }

    if (parts[1] === "notify" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { chatId, text } = JSON.parse(body || "{}");
      if (!chatId || !text) return send(res, 400, { error: "chatId and text are required" });
      const result = await sendTelegram(chatId, text);
      return send(res, 200, result);
    }

    if (parts[1] === "checkout" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { userId, email } = JSON.parse(body || "{}");
      if (!userId || !email) return send(res, 400, { error: "userId and email are required" });
      const url2 = await createCheckoutSession(userId, email);
      return send(res, 200, { url: url2 });
    }

    if (parts[1] === "stripe-webhook" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const signature = req.headers["stripe-signature"];
      const event = verifyWebhookEvent(rawBody, signature);
      await handleWebhookEvent(event, updateProfile);
      return send(res, 200, { received: true });
    }

    return send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: "REQUEST FAILED", detail: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
