import { useState } from 'react';
import { api, relativeTime } from '../api.js';

export default function Alerts({ alerts, onChanged, onOpenMachine, canWrite = false }) {
  const [triage, setTriage] = useState({}); // alertId -> triage result
  const [busy, setBusy] = useState({}); // alertId -> 'triage' | 'ack' | 'resolve'
  const [filter, setFilter] = useState('all');

  const rows = filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter);

  async function act(id, fn, kind) {
    setBusy((b) => ({ ...b, [id]: kind }));
    try {
      await fn();
      onChanged?.();
    } finally {
      setBusy((b) => ({ ...b, [id]: undefined }));
    }
  }

  async function runTriage(alert) {
    setBusy((b) => ({ ...b, [alert._id]: 'triage' }));
    try {
      const result = await api.triageAlert(alert._id);
      setTriage((t) => ({ ...t, [alert._id]: result }));
    } catch (e) {
      setTriage((t) => ({ ...t, [alert._id]: { error: e.message } }));
    } finally {
      setBusy((b) => ({ ...b, [alert._id]: undefined }));
    }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Alert queue - {rows.length} open</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 150 }}>
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
      </div>

      {rows.length === 0 && <div className="empty">Queue is clear.</div>}

      {rows.map((a) => {
        const t = triage[a._id];
        return (
          <div className="alert-item" key={a._id}>
            <span className={`alert-bar ${a.severity}`} />
            <div className="alert-main">
              <div className="alert-msg">{a.message}</div>
              <div className="alert-meta">
                <span className={`tag ${a.severity}`}>{a.type}</span>
                <button
                  className="num"
                  style={{ background: 'none', border: 'none', padding: 0, color: 'var(--signal)' }}
                  onClick={() => onOpenMachine(a.machineCode)}
                >
                  {a.machineCode}
                </button>
                <span>opened {relativeTime(a.openedAt)}</span>
                {a.status === 'acknowledged' && <span className="tag">acknowledged</span>}
              </div>

              {t && (
                <div className="triage">
                  {t.error ? (
                    <span className="error">{t.error}</span>
                  ) : (
                    <>
                      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                        <strong style={{ fontSize: 12 }}>AI triage</strong>
                        <span className="faint" style={{ fontSize: 11 }}>
                          {t.provider === 'claude' ? `Claude - ${t.model}` : 'offline analyzer (no API key)'}
                          {t.triage.confidence != null && ` - ${Math.round(t.triage.confidence * 100)}% confidence`}
                        </span>
                      </div>
                      <dl style={{ margin: 0 }}>
                        <dt>Diagnosis</dt>
                        <dd>{t.triage.diagnosis}</dd>
                        <dt>Likely cause</dt>
                        <dd>{t.triage.likelyCause}</dd>
                        <dt>Recommended action</dt>
                        <dd>{t.triage.recommendedAction}</dd>
                      </dl>
                      <div style={{ marginTop: 8 }}>
                        {t.triage.dispatchRequired ? (
                          <span className="tag critical">dispatch required</span>
                        ) : (
                          <span className="tag ok">no dispatch needed</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="alert-actions">
              <button onClick={() => runTriage(a)} disabled={busy[a._id] === 'triage'}>
                {busy[a._id] === 'triage' ? 'Analyzing...' : t ? 'Re-triage' : 'Triage'}
              </button>
              {canWrite && a.status === 'open' && (
                <button onClick={() => act(a._id, () => api.acknowledgeAlert(a._id), 'ack')} disabled={!!busy[a._id]}>
                  Ack
                </button>
              )}
              {canWrite && (
                <button onClick={() => act(a._id, () => api.resolveAlert(a._id), 'resolve')} disabled={!!busy[a._id]}>
                  Resolve
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
