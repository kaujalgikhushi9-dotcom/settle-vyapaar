const { computeQuote } = require("./pricing");

const TTL_MS = 15 * 60 * 1000;
const PREFIX = "q_";

// Serverless deployments (Vercel) do not keep one process alive between
// requests, so the quote travels inside its own id. The price is recomputed
// from the id's inputs, so a quote keeps working across instances and a
// tampered id can only describe a different, still-consistent quote.
const memory = new Map(); // per-instance extras: PayPal order id, paid status

function encodePayload(payload) {
  return PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodePayload(id) {
  if (typeof id !== "string" || !id.startsWith(PREFIX)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(id.slice(PREFIX.length), "base64url").toString("utf8")
    );

    const valid =
      payload &&
      Number.isFinite(payload.t) &&
      Number.isFinite(payload.b) &&
      Number.isFinite(payload.r) &&
      Number.isFinite(payload.iat);

    return valid ? payload : null;
  } catch (e) {
    return null;
  }
}

function hydrate(payload, id = encodePayload(payload)) {
  const quote = computeQuote({
    sellerInrTarget: payload.t,
    bufferPct: payload.b,
    midRate: payload.r,
    profile: payload.p,
  });

  const extra = memory.get(id) || {};
  const expiresAt = payload.iat + TTL_MS;
  const isExpired = Date.now() > expiresAt;

  const status =
    extra.status === "paid" ? "paid" : isExpired ? "expired" : "open";

  return {
    ...quote,
    id,
    rate_source: payload.l
      ? "Frankfurter (ECB reference rate)"
      : "Saved snapshot (live rate API unavailable)",
    rate_is_live: Boolean(payload.l),
    order_id: extra.order_id || null,
    status,
    locked_at: new Date(payload.iat).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    ...(extra.paid_at ? { paid_at: extra.paid_at } : {}),
  };
}

function saveQuote(q) {
  const payload = {
    t: q.seller_inr_target,
    b: q.buffer_pct,
    r: q.mid_rate,
    p: q.fx_profile,
    iat: Date.now(),
    l: q.rate_is_live ? 1 : 0,
  };

  return hydrate(payload);
}

function getQuote(id) {
  const payload = decodePayload(id);

  if (!payload) return null;

  return hydrate(payload, id);
}

function recordOrder(quoteId, orderId) {
  if (!decodePayload(quoteId)) return;

  memory.set(quoteId, {
    ...(memory.get(quoteId) || {}),
    order_id: orderId,
    payload: decodePayload(quoteId),
  });
}

function markPaid(id) {
  const payload = decodePayload(id);

  if (!payload) return;

  memory.set(id, {
    ...(memory.get(id) || {}),
    status: "paid",
    paid_at: new Date().toISOString(),
    payload,
  });
}

function findByOrder(orderId) {
  for (const [id, extra] of memory) {
    if (extra.order_id === orderId) return hydrate(extra.payload, id);
  }

  return null;
}

function instanceQuotes() {
  const quotes = [];

  for (const [id, extra] of memory) {
    if (!extra.payload) continue;

    const quote = hydrate(extra.payload, id);

    if (quote.status === "open" || quote.status === "paid") quotes.push(quote);
  }

  return quotes;
}

function getEarningsOverview() {
  const quotes = instanceQuotes();
  const paidQuotes = quotes.filter((q) => q.status === "paid");

  const completedInr = paidQuotes.reduce(
    (total, q) => total + Number(q.seller_inr_target || 0),
    0
  );

  const openQuotes = quotes.filter((q) => q.status === "open");
  const pendingInr = openQuotes.reduce(
    (total, q) => total + Number(q.seller_inr_target || 0),
    0
  );

  const months = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = date.toLocaleString("en-US", { month: "short" });
    const year = date.getFullYear();
    const month = date.getMonth();

    const monthTotal = paidQuotes.reduce((total, q) => {
      const paidDate = q.paid_at ? new Date(q.paid_at) : null;

      if (!paidDate) return total;

      const matchesMonth =
        paidDate.getFullYear() === year &&
        paidDate.getMonth() === month;

      return matchesMonth
        ? total + Number(q.seller_inr_target || 0)
        : total;
    }, 0);

    months.push({
      month: label,
      amount: monthTotal,
    });
  }

  return {
    completed_inr: completedInr,
    pending_inr: pendingInr,
    completed_count: paidQuotes.length,
    pending_count: openQuotes.length,
    total_quotes: quotes.length,
    monthly: months,
  };
}

function getTransactions() {
  return instanceQuotes()
    .map((q) => ({
      id: q.id,
      seller_inr_target: q.seller_inr_target,
      buyer_price: q.buyer_price,
      status: q.status,
      locked_at: q.locked_at,
      expires_at: q.expires_at,
      order_id: q.order_id || null,
      paid_at: q.paid_at || null,
    }))
    .sort((a, b) => new Date(b.locked_at) - new Date(a.locked_at));
}

module.exports = {
  saveQuote,
  getQuote,
  markPaid,
  findByOrder,
  recordOrder,
  getEarningsOverview,
  getTransactions,
  TTL_MS,
};
