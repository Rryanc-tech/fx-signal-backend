const BASE_URL = "https://api.twelvedata.com";
const API_KEY = process.env.TWELVE_DATA_API_KEY; // server-side only

const TIMEFRAME_MAP = { "5M": "5min", "15M": "15min", "1H": "1h", "4H": "4h", "1D": "1day" };

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Market data request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(`Provider error: ${data.message}`);
  return data;
}

async function getQuote(symbol) {
  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;
  const q = await fetchJSON(url);
  const mid = parseFloat(q.close);
  const ts = q.timestamp ? q.timestamp * 1000 : Date.now();
  const ageSeconds = (Date.now() - ts) / 1000;

  return {
    symbol,
    mid,
    bid: null,
    ask: null,
    spreadPips: null,
    changePct: parseFloat(q.percent_change),
    dayHigh: parseFloat(q.high),
    dayLow: parseFloat(q.low),
    timestamp: ts,
    source: "twelvedata",
    freshness: ageSeconds < 30 ? "live" : ageSeconds < 300 ? "delayed" : "stale",
  };
}

async function getCandles(symbol, timeframe, limit = 140) {
  const interval = TIMEFRAME_MAP[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${limit}&apikey=${API_KEY}`;
  const data = await fetchJSON(url);
  if (!Array.isArray(data.values)) throw new Error("Malformed candle response");

  const candles = data.values
    .map((v) => ({
      time: new Date(v.datetime).getTime(),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0))
    .reverse();

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time <= candles[i - 1].time) throw new Error("Candle timestamp order violation — rejecting series");
  }
  return candles;
}

function getMarketStatus() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const closed = day === 6 || (day === 0 && hour < 21) || (day === 5 && hour >= 21);
  return { open: !closed, checkedAt: now.toISOString() };
}

async function getSpread(symbol) {
  const q = await getQuote(symbol);
  return q.spreadPips;
}

module.exports = { getQuote, getCandles, getMarketStatus, getSpread };
