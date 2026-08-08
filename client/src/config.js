/**
 * Where the API lives.
 *
 * Two deployment shapes are supported and they differ only here:
 *
 *  - Single origin (Render, Docker, `npm start`): Express serves both the API
 *    and this bundle, so relative URLs work and VITE_API_URL is unset.
 *
 *  - Split origin (SPA on Vercel, API elsewhere): the bundle is served from a
 *    different host than the API, so every request needs an absolute URL and
 *    the WebSocket cannot be derived from window.location.
 *
 * Vite inlines VITE_* variables at build time, so this is fixed when the bundle
 * is built - it is not runtime configuration.
 */
const RAW = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');

/** Base for REST calls. Empty string means "same origin". */
export const API_BASE = RAW;

/** Absolute ws:// or wss:// URL for the live feed. */
export function websocketUrl(ticket) {
  const query = `?ticket=${encodeURIComponent(ticket)}`;

  if (!API_BASE) {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/ws${query}`;
  }

  // http -> ws, https -> wss. Swapping the scheme this way keeps the port and
  // any path prefix that the API base already carries.
  return `${API_BASE.replace(/^http/, 'ws')}/ws${query}`;
}

/** Shown in the UI footer so a deployed build says which API it is talking to. */
export const API_ORIGIN_LABEL = API_BASE || 'same origin';
