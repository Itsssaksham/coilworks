import { useState } from 'react';
import { relativeTime, money } from '../api.js';

export default function Machines({ machines, flashed, onOpenMachine }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  const rows = machines.filter((m) => {
    if (filter !== 'all' && m.status !== filter) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      m.code.toLowerCase().includes(needle) ||
      m.name.toLowerCase().includes(needle) ||
      m.siteName.toLowerCase().includes(needle)
    );
  });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Fleet - {rows.length} machines</h2>
        <div className="row">
          <input
            placeholder="Search code or site..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 200 }}
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 130 }}>
            <option value="all">All statuses</option>
            <option value="online">Online</option>
            <option value="fault">Fault</option>
            <option value="offline">Offline</option>
          </select>
        </div>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Status</th><th>Code</th><th>Site</th><th>Fill</th>
              <th>Temp</th><th>Cash</th><th>Signal</th><th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const units = m.slots?.reduce((n, s) => n + s.qty, 0) ?? 0;
              const cap = m.slots?.reduce((n, s) => n + s.capacity, 0) ?? 1;
              const pct = Math.round((units / cap) * 100);
              const chilled = !m.model?.includes('Ambient');
              const tempBad = chilled && m.temperatureC != null && (m.temperatureC > 7 || m.temperatureC < 1);

              return (
                <tr
                  key={m.code}
                  className={`clickable ${flashed.has(m.code) ? 'flash' : ''}`}
                  onClick={() => onOpenMachine(m.code)}
                >
                  <td><span className={`dot ${m.status}`} /></td>
                  <td className="num">{m.code}</td>
                  <td>
                    {m.siteName}
                    <div className="faint" style={{ fontSize: 11.5 }}>{m.name}</div>
                  </td>
                  <td>
                    <div className="row">
                      <div className="bar" style={{ flex: 1 }}>
                        <span className={pct < 20 ? 'crit' : pct < 40 ? 'low' : ''} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="num faint" style={{ fontSize: 11.5, minWidth: 32 }}>{pct}%</span>
                    </div>
                  </td>
                  <td className="num" style={{ color: tempBad ? 'var(--crit)' : undefined }}>
                    {m.temperatureC != null ? `${m.temperatureC.toFixed(1)}C` : '--'}
                  </td>
                  <td className="num muted">{money(m.cashCents ?? 0)}</td>
                  <td className="num muted">{m.signalStrength ?? '--'}</td>
                  <td className="num faint">{relativeTime(m.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No machines match that filter.</div>}
      </div>
    </section>
  );
}
