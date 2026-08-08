import { useEffect, useState } from 'react';
import { api, money, relativeTime } from '../api.js';
import Chart from '../components/Chart.jsx';
import FleetMap from '../components/FleetMap.jsx';

export default function Dashboard({ machines, alerts, onOpenMachine }) {
  const [summary, setSummary] = useState(null);
  const [sales, setSales] = useState([]);
  const [top, setTop] = useState([]);
  const [forecast, setForecast] = useState([]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.summary(), api.salesByHour(24), api.topProducts(7), api.forecast(3)])
      .then(([s, h, t, f]) => {
        if (!alive) return;
        setSummary(s);
        setSales(h);
        setTop(t);
        setForecast(f);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Machine counts come from the live socket rather than the summary fetch, so
  // this row moves the instant a machine changes state.
  const live = {
    total: machines.length,
    online: machines.filter((m) => m.status === 'online').length,
    fault: machines.filter((m) => m.status === 'fault').length,
    offline: machines.filter((m) => m.status === 'offline').length,
  };

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const unitsOnHand = machines.reduce((n, m) => n + (m.slots?.reduce((k, s) => k + s.qty, 0) ?? 0), 0);
  const capacity = machines.reduce((n, m) => n + (m.slots?.reduce((k, s) => k + s.capacity, 0) ?? 0), 0);
  const fillPct = capacity ? Math.round((unitsOnHand / capacity) * 100) : 0;
  const cash = machines.reduce((n, m) => n + (m.cashCents ?? 0), 0);

  return (
    <>
      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Machines online</div>
          <div className="kpi-value">
            {live.online}<span className="faint" style={{ fontSize: 16 }}>/{live.total}</span>
          </div>
          <div className="kpi-sub">
            {live.fault > 0 && <span style={{ color: 'var(--crit)' }}>{live.fault} faulted </span>}
            {live.offline > 0 && <span className="faint">{live.offline} offline</span>}
            {live.fault === 0 && live.offline === 0 && <span style={{ color: 'var(--ok)' }}>all reporting</span>}
          </div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Open alerts</div>
          <div className="kpi-value" style={{ color: criticalCount > 0 ? 'var(--crit)' : undefined }}>
            {alerts.length}
          </div>
          <div className="kpi-sub">{criticalCount} critical</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Fill level</div>
          <div className="kpi-value">{fillPct}%</div>
          <div className="kpi-sub">{unitsOnHand.toLocaleString()} of {capacity.toLocaleString()} units</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Revenue 24h</div>
          <div className="kpi-value">{summary ? money(summary.last24h.revenueCents) : '--'}</div>
          <div className="kpi-sub">{summary ? `${summary.last24h.units} vends` : ''}</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Cash on hand</div>
          <div className="kpi-value">{money(cash)}</div>
          <div className="kpi-sub">across {live.total} machines</div>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Vends per hour - last 24h</h2>
            </div>
            <div className="panel-body">
              <Chart points={sales} valueKey="units" label="vends per hour" />
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Emptying within 3 days</h2>
              <span className="faint num">{forecast.length} slots</span>
            </div>
            <div className="table-scroll">
              {forecast.length === 0 ? (
                <div className="empty">Nothing forecast to run out in the next 3 days.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Machine</th><th>Slot</th><th>Product</th>
                      <th>Left</th><th>Rate/day</th><th>Empty in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {forecast.slice(0, 12).map((f) => (
                      <tr key={`${f.machineCode}-${f.slotCode}`} className="clickable"
                          onClick={() => onOpenMachine(f.machineCode)}>
                        <td className="num">{f.machineCode}</td>
                        <td className="num">{f.slotCode}</td>
                        <td className="muted">{f.sku}</td>
                        <td className="num">{f.qty}</td>
                        <td className="num muted">{f.ratePerDay}</td>
                        <td className="num" style={{ color: f.daysToEmpty <= 1 ? 'var(--crit)' : 'var(--warn)' }}>
                          {f.daysToEmpty == null ? '--' : `${f.daysToEmpty}d`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Fleet map</h2></div>
            <div className="panel-body">
              <FleetMap machines={machines} onSelect={onOpenMachine} />
              <div className="wrap" style={{ marginTop: 10, fontSize: 12 }}>
                <span className="row"><i className="dot online" /> online</span>
                <span className="row"><i className="dot fault" /> fault</span>
                <span className="row"><i className="dot offline" /> offline</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Top sellers - 7 days</h2></div>
            <table>
              <tbody>
                {top.slice(0, 6).map((p) => (
                  <tr key={p.sku}>
                    <td>{p.name}</td>
                    <td className="num muted" style={{ textAlign: 'right' }}>{p.units}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{money(p.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Latest activity</h2></div>
            <div>
              {alerts.slice(0, 5).map((a) => (
                <div className="alert-item" key={a._id}>
                  <span className={`alert-bar ${a.severity}`} />
                  <div className="alert-main">
                    <div className="alert-msg">{a.message}</div>
                    <div className="alert-meta">
                      <span className="num">{a.machineCode}</span>
                      <span>{relativeTime(a.openedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {alerts.length === 0 && <div className="empty">No open alerts.</div>}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
