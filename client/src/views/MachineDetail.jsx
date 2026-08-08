import { useEffect, useState } from 'react';
import { api, money, relativeTime } from '../api.js';

export default function MachineDetail({ code, onBack, canWrite = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.machine(code).then(setData).catch((e) => setError(e.message));

  useEffect(() => {
    setData(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (error) return <div className="panel"><div className="empty">{error}</div></div>;
  if (!data) return <div className="panel"><div className="empty">Loading {code}...</div></div>;

  const { machine, alerts, telemetry, fillRatio } = data;
  const lowSlots = machine.slots.filter((s) => s.qty <= s.parLevel);

  async function restockAll() {
    setBusy(true);
    try {
      await api.restock(
        machine.code,
        lowSlots.map((s) => ({ slotCode: s.code, qty: s.capacity - s.qty })),
      );
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Temperature series for the sparkline, oldest first.
  const temps = telemetry.filter((t) => t.temperatureC != null);
  const tMin = Math.min(...temps.map((t) => t.temperatureC), 0);
  const tMax = Math.max(...temps.map((t) => t.temperatureC), 10);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="row">
            <button onClick={onBack}>&larr; Fleet</button>
            <h1 style={{ marginLeft: 8 }}>
              <span className="num">{machine.code}</span> <span className="muted">{machine.name}</span>
            </h1>
          </div>
          <p>
            {machine.siteName} - {machine.address} - {machine.model} - firmware{' '}
            <span className="num">{machine.firmware}</span>
          </p>
        </div>
        <div className="row">
          <span className={`tag ${machine.status === 'online' ? 'ok' : machine.status === 'fault' ? 'critical' : ''}`}>
            <i className={`dot ${machine.status}`} /> {machine.status}
          </span>
          <span className="faint">seen {relativeTime(machine.lastSeenAt)}</span>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Fill</div>
          <div className="kpi-value">{Math.round(fillRatio * 100)}%</div>
          <div className="kpi-sub">{lowSlots.length} slots at or below par</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Cabinet temp</div>
          <div className="kpi-value">{machine.temperatureC?.toFixed(1) ?? '--'}C</div>
          <div className="kpi-sub">target 1-7C when chilled</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Cash box</div>
          <div className="kpi-value">{money(machine.cashCents)}</div>
          <div className="kpi-sub">
            {Math.round((machine.cashCents / machine.cashCapacityCents) * 100)}% of capacity
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Signal</div>
          <div className="kpi-value">{machine.signalStrength ?? '--'}</div>
          <div className="kpi-sub">0-100</div>
        </div>
      </div>

      <div className="split">
        <section className="panel">
          <div className="panel-head">
            <h2>Planogram</h2>
            {canWrite ? (
              <button className="primary" onClick={restockAll} disabled={busy || lowSlots.length === 0}>
                {busy ? 'Loading...' : `Restock ${lowSlots.length} slot(s)`}
              </button>
            ) : (
              <span className="faint" style={{ fontSize: 12 }}>
                {lowSlots.length} slot(s) below par
              </span>
            )}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Slot</th><th>SKU</th><th>Level</th><th>Qty</th><th>Par</th><th>Price</th><th /></tr>
              </thead>
              <tbody>
                {machine.slots.map((s) => {
                  const pct = Math.round((s.qty / s.capacity) * 100);
                  return (
                    <tr key={s.code}>
                      <td className="num">{s.code}</td>
                      <td className="muted">{s.sku}</td>
                      <td style={{ width: 110 }}>
                        <div className="bar">
                          <span className={s.qty === 0 ? 'crit' : s.qty <= s.parLevel ? 'low' : ''} style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                      <td className="num">{s.qty}/{s.capacity}</td>
                      <td className="num faint">{s.parLevel}</td>
                      <td className="num muted">{money(s.priceCents)}</td>
                      <td>{s.jammed && <span className="tag critical">jam</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Cabinet temperature</h2>
              <span className="faint num">{temps.length} readings</span>
            </div>
            <div className="panel-body">
              {temps.length < 2 ? (
                <div className="empty">Not enough telemetry yet. Start the simulator.</div>
              ) : (
                <svg className="chart" viewBox="0 0 600 130" preserveAspectRatio="none" role="img"
                     aria-label="Cabinet temperature over recent readings">
                  {/* Chilled target band, 1-7C */}
                  <rect
                    x="0"
                    y={122 - ((7 - tMin) / (tMax - tMin || 1)) * 114}
                    width="600"
                    height={Math.max(2, ((7 - 1) / (tMax - tMin || 1)) * 114)}
                    fill="rgba(63,191,111,0.10)"
                  />
                  <path
                    className="line"
                    d={temps
                      .map((t, i) => {
                        const x = (i / Math.max(1, temps.length - 1)) * 600;
                        const y = 122 - ((t.temperatureC - tMin) / (tMax - tMin || 1)) * 114;
                        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')}
                  />
                  <text x="4" y="12" fill="#6f6862" fontSize="10" fontFamily="ui-monospace, monospace">
                    {tMax.toFixed(1)}C
                  </text>
                  <text x="4" y="126" fill="#6f6862" fontSize="10" fontFamily="ui-monospace, monospace">
                    {tMin.toFixed(1)}C
                  </text>
                </svg>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Open alerts</h2></div>
            <div>
              {alerts.length === 0 && <div className="empty">Nothing open on this machine.</div>}
              {alerts.map((a) => (
                <div className="alert-item" key={a._id}>
                  <span className={`alert-bar ${a.severity}`} />
                  <div className="alert-main">
                    <div className="alert-msg">{a.message}</div>
                    <div className="alert-meta">
                      <span className={`tag ${a.severity}`}>{a.type}</span>
                      <span>{relativeTime(a.openedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
