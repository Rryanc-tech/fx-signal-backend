const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

async function getUpcomingHighImpactEvents(hoursAhead = 24) {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY not configured on the backend");
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + hoursAhead * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Economic calendar request failed: ${res.status}`);
  const data = await res.json();
  const events = Array.isArray(data.economicCalendar) ? data.economicCalendar : [];

  const now = Date.now();
  return events
    .filter((e) => e.impact === "high" || e.impact === 3)
    .map((e) => ({
      event: e.event,
      country: e.country,
      time: new Date(e.time).getTime(),
      minutesUntil: Math.round((new Date(e.time).getTime() - now) / 60000),
    }))
    .filter((e) => e.minutesUntil > -30 && e.minutesUntil < hoursAhead * 60)
    .sort((a, b) => a.time - b.time);
}

function relevantEventFor(symbol, events, withinMinutes = 60) {
  const currencies = symbol.split("/");
  const countryMap = { USD: "US", EUR: "EU", GBP: "GB", JPY: "JP", CAD: "CA", AUD: "AU", NZD: "NZ", CHF: "CH" };
  const relevantCountries = currencies.map((c) => countryMap[c]).filter(Boolean);
  return events
    .filter((e) => relevantCountries.includes(e.country) && Math.abs(e.minutesUntil) <= withinMinutes)
    .sort((a, b) => Math.abs(a.minutesUntil) - Math.abs(b.minutesUntil))[0] || null;
}

module.exports = { getUpcomingHighImpactEvents, relevantEventFor };
