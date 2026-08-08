/** Thin API client. Holds the operator token and attaches it to every request. */
import { API_BASE } from './config.js';

const TOKEN_KEY = 'coilworks.token';

/** Roles allowed to change fleet state. Mirrors requireWriteAccess on the server. */
export const WRITE_ROLES = ['dispatcher', 'admin'];

/**
 * Whether this operator can mutate. The server enforces this independently -
 * this only decides what the UI offers, so a disabled button is a courtesy,
 * not the security boundary.
 */
export const canWrite = (operator) => WRITE_ROLES.includes(operator?.role);

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  // API_BASE is "" on a single-origin deploy, so this stays a relative URL there.
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('coilworks:unauthorized'));
    throw new Error('Session expired');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  me: () => request('/auth/me'),
  // Short-lived single-use credential for the WebSocket upgrade - see useLive.js.
  wsTicket: () => request('/auth/ws-ticket', { method: 'POST' }),

  /** Returns `{ machines, total, limit, offset }`. */
  machines: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    return request(`/machines${q.toString() ? `?${q}` : ''}`);
  },
  machine: (code) => request(`/machines/${code}`),
  restock: (code, picks) => request(`/machines/${code}/restock`, { method: 'POST', body: { picks } }),

  alerts: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    return request(`/alerts${q.toString() ? `?${q}` : ''}`);
  },
  acknowledgeAlert: (id) => request(`/alerts/${id}/acknowledge`, { method: 'POST' }),
  resolveAlert: (id) => request(`/alerts/${id}/resolve`, { method: 'POST' }),
  triageAlert: (id, force = false) =>
    request(`/alerts/${id}/triage${force ? '?force=1' : ''}`, { method: 'POST' }),

  summary: () => request('/analytics/summary'),
  salesByHour: (hours = 24) => request(`/analytics/sales-by-hour?hours=${hours}`),
  topProducts: (days = 7) => request(`/analytics/top-products?days=${days}`),
  forecast: (horizonDays = 7) => request(`/analytics/forecast?horizonDays=${horizonDays}`),

  runs: () => request('/runs'),
  planRun: (body) => request('/runs/plan', { method: 'POST', body }),
  setRunStatus: (id, status) => request(`/runs/${id}/status`, { method: 'POST', body: { status } }),

  ask: (question) => request('/ai/ask', { method: 'POST', body: { question } }),
  aiProvider: () => request('/ai/provider'),
};

export const money = (cents) =>
  `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const relativeTime = (date) => {
  if (!date) return 'never';
  const seconds = Math.round((Date.now() - new Date(date)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};
