import { useCallback, useEffect, useRef, useState } from 'react';
import { api, getToken, clearToken, canWrite } from './api.js';
import { useLive } from './useLive.js';
import Login from './components/Login.jsx';
import Dashboard from './views/Dashboard.jsx';
import Machines from './views/Machines.jsx';
import MachineDetail from './views/MachineDetail.jsx';
import Alerts from './views/Alerts.jsx';
import Runs from './views/Runs.jsx';
import Assistant from './views/Assistant.jsx';

const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'machines', label: 'Fleet' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'runs', label: 'Restock runs' },
  { id: 'assistant', label: 'Ops assistant' },
];

export default function App() {
  const [operator, setOperator] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('dashboard');
  const [openMachine, setOpenMachine] = useState(null);

  const [machines, setMachines] = useState([]);
  const [alerts, setAlerts] = useState([]);

  // Codes whose row should flash because a live event just touched them.
  const [flashed, setFlashed] = useState(new Set());
  const flashTimers = useRef(new Map());

  // Restore a session from a stored token on first load.
  useEffect(() => {
    if (!getToken()) return setBooting(false);
    api.me()
      .then(setOperator)
      .catch(() => clearToken())
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setOperator(null);
    window.addEventListener('coilworks:unauthorized', onUnauthorized);
    return () => window.removeEventListener('coilworks:unauthorized', onUnauthorized);
  }, []);

  const loadAll = useCallback(() => {
    if (!getToken()) return;
    // The machines endpoint is paginated and returns an envelope, not an array.
    api.machines({ limit: 500 }).then((r) => setMachines(r.machines)).catch(() => {});
    api.alerts({ status: 'open' }).then(setAlerts).catch(() => {});
  }, []);

  useEffect(() => { if (operator) loadAll(); }, [operator, loadAll]);

  const flash = useCallback((code) => {
    setFlashed((prev) => new Set(prev).add(code));
    clearTimeout(flashTimers.current.get(code));
    flashTimers.current.set(
      code,
      setTimeout(() => {
        setFlashed((prev) => {
          const next = new Set(prev);
          next.delete(code);
          return next;
        });
      }, 1200),
    );
  }, []);

  /**
   * Apply a live event to local state.
   *
   * These arrive from MongoDB change streams via the server's WebSocket, so the
   * UI reflects a database write within milliseconds and never polls.
   */
  const onLiveEvent = useCallback(
    (topic, payload) => {
      if (topic === 'machines') {
        const incoming = payload.machine;
        setMachines((prev) => {
          const i = prev.findIndex((m) => m.code === incoming.code);
          if (i === -1) return [...prev, incoming];
          const next = [...prev];
          next[i] = { ...next[i], ...incoming };
          return next;
        });
        flash(incoming.code);
      }

      if (topic === 'alerts') {
        const incoming = payload.alert;
        setAlerts((prev) => {
          const rest = prev.filter((a) => a._id !== incoming._id);
          // Resolved alerts leave the open queue.
          return incoming.status === 'resolved' ? rest : [incoming, ...rest];
        });
      }
    },
    [flash],
  );

  const { connected, degradedTopics } = useLive(operator ? onLiveEvent : null);
  // A dropped change stream means the data on screen has stopped updating. Say
  // so rather than showing a green light over frozen numbers.
  const stale = connected && degradedTopics.length > 0;

  function signOut() {
    clearToken();
    setOperator(null);
    setMachines([]);
    setAlerts([]);
  }

  function goToMachine(code) {
    setOpenMachine(code);
    setView('machines');
  }

  if (booting) return <div className="login-wrap"><span className="faint">Loading...</span></div>;
  if (!operator) return <Login onAuthed={setOperator} />;

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          Coilworks
        </div>

        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${view === item.id && !openMachine ? 'active' : ''}`}
            onClick={() => { setView(item.id); setOpenMachine(null); }}
          >
            {item.label}
            {item.id === 'alerts' && criticalCount > 0 && (
              <span className="nav-count">{criticalCount}</span>
            )}
          </button>
        ))}

        <div className="sidebar-foot">
          <div className="live" style={{ marginBottom: 8 }}>
            <span className={`live-dot ${!connected ? 'off' : stale ? 'stale' : ''}`} />
            {!connected
              ? 'Reconnecting...'
              : stale
                ? `Stale: ${degradedTopics.join(', ')}`
                : 'Live feed connected'}
          </div>
          <div>{operator.name}</div>
          <div className="faint" style={{ marginBottom: 8 }}>{operator.role}</div>
          {!canWrite(operator) && (
            <div className="readonly-note">
              Read-only access. You can explore everything; changing fleet state
              needs a dispatcher account.
            </div>
          )}
          <button onClick={signOut} style={{ width: '100%', fontSize: 12 }}>Sign out</button>
        </div>
      </nav>

      <main className="main">
        {openMachine ? (
          <MachineDetail code={openMachine} onBack={() => setOpenMachine(null)} canWrite={canWrite(operator)} />
        ) : (
          <>
            <div className="page-head">
              <div>
                <h1>{NAV.find((n) => n.id === view)?.label}</h1>
                <p>
                  {view === 'dashboard' && 'Live fleet state, pushed from MongoDB change streams.'}
                  {view === 'machines' && 'Every machine, newest telemetry first.'}
                  {view === 'alerts' && 'Open alerts raised by the rules engine, with AI triage on demand.'}
                  {view === 'runs' && 'Forecast-driven restock rounds, ordered into a route.'}
                  {view === 'assistant' && 'Natural-language questions answered from live fleet queries.'}
                </p>
              </div>
              <span className="live">
                <span className={`live-dot ${!connected ? 'off' : stale ? 'stale' : ''}`} />
                {!connected ? 'offline' : stale ? 'stale' : 'live'}
              </span>
            </div>

            {view === 'dashboard' && (
              <Dashboard machines={machines} alerts={alerts} onOpenMachine={goToMachine} />
            )}
            {view === 'machines' && (
              <Machines machines={machines} flashed={flashed} onOpenMachine={goToMachine} />
            )}
            {view === 'alerts' && (
              <Alerts alerts={alerts} onChanged={loadAll} onOpenMachine={goToMachine} canWrite={canWrite(operator)} />
            )}
            {view === 'runs' && <Runs machines={machines} canWrite={canWrite(operator)} />}
            {view === 'assistant' && <Assistant />}
          </>
        )}
      </main>
    </div>
  );
}
