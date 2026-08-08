import crypto from 'node:crypto';

/**
 * Short-lived, single-use tickets for authenticating a WebSocket upgrade.
 *
 * Why not just put the JWT in the query string? Because browsers cannot set
 * headers on a WebSocket handshake, so the token has to travel in the URL - and
 * URLs end up in proxy logs, access logs, and browser history. A long-lived
 * session token in all three places is a bad trade.
 *
 * A ticket is issued over the already-authenticated REST API, lives for 30
 * seconds, and is consumed on first use. Leaking one from a log costs an
 * attacker nothing: by the time it is read it is expired and already redeemed.
 */
const TTL_MS = 30_000;

/** @type {Map<string, {operator: object, expiresAt: number}>} */
const tickets = new Map();

export function issueTicket(operator) {
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, {
    operator: { sub: operator.sub, email: operator.email, role: operator.role },
    expiresAt: Date.now() + TTL_MS,
  });
  return { ticket, expiresInSeconds: TTL_MS / 1000 };
}

/**
 * Redeem a ticket. Returns the operator it was issued to, or null if the ticket
 * is unknown, already used, or expired.
 */
export function redeemTicket(ticket) {
  if (!ticket) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;

  // Single use: delete on lookup regardless of whether it turns out to be valid.
  tickets.delete(ticket);

  if (Date.now() > entry.expiresAt) return null;
  return entry.operator;
}

/** Drop expired tickets so the map cannot grow without bound. */
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) if (now > entry.expiresAt) tickets.delete(ticket);
}, 60_000);
sweep.unref();

export const _ticketCount = () => tickets.size;
