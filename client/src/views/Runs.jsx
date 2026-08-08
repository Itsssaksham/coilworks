import { useEffect, useState } from 'react';
import { api } from '../api.js';
import FleetMap from '../components/FleetMap.jsx';

// Sector 17, Chandigarh - the default depot the planner routes from.
const DEPOT = { lat: 30.7410, lng: 76.7794 };

export default function Runs({ machines }) {
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [horizon, setHorizon] = useState(4);
  const [maxStops, setMaxStops] = useState(10);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = () => api.runs().then(setRuns).catch(() => {});
  useEffect(() => { load(); }, []);

  async function plan() {
    setBusy(true);
    setNote(null);
    try {
      const res = await api.planRun({
        name: `Run ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        depotLat: DEPOT.lat,
        depotLng: DEPOT.lng,
        horizonDays: Number(horizon),
        maxStops: Number(maxStops),
      });
      if (!res.run) {
        setNote(res.reason);
      } else {
        setSelected(res.run);
        await load();
      }
    } catch (e) {
      setNote(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="split">
      <div className="stack">
        <section className="panel">
          <div className="panel-head">
            <h2>Plan a restock run</h2>
          </div>
          <div className="panel-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              Stops are chosen from the depletion forecast - machines that will actually run out inside
              the horizon, not a fixed schedule - then ordered into a route from the depot.
            </p>
            <div className="wrap" style={{ alignItems: 'flex-end' }}>
              <div style={{ width: 150 }}>
                <label className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>Horizon (days)</label>
                <input type="number" min="1" max="30" value={horizon} onChange={(e) => setHorizon(e.target.value)} />
              </div>
              <div style={{ width: 150 }}>
                <label className="faint" style={{ fontSize: 11, textTransform: 'uppercase' }}>Max stops</label>
                <input type="number" min="1" max="40" value={maxStops} onChange={(e) => setMaxStops(e.target.value)} />
              </div>
              <button className="primary" onClick={plan} disabled={busy}>
                {busy ? 'Planning...' : 'Plan run'}
              </button>
            </div>
            {note && <div className="error">{note}</div>}
          </div>
        </section>

        {selected && (
          <section className="panel">
            <div className="panel-head">
              <h2>{selected.name}</h2>
              <span className="faint num">
                {selected.stops.length} stops - {(selected.totalMeters / 1000).toFixed(1)} km - {selected.totalUnits} units
              </span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>#</th><th>Machine</th><th>Site</th><th>Leg</th><th>Units</th><th>Picks</th></tr>
                </thead>
                <tbody>
                  {selected.stops.map((s) => (
                    <tr key={s.machineCode}>
                      <td className="num">{s.order}</td>
                      <td className="num">{s.machineCode}</td>
                      <td>
                        {s.name}
                        <div className="faint" style={{ fontSize: 11.5 }}>{s.address}</div>
                      </td>
                      <td className="num muted">{(s.legMeters / 1000).toFixed(1)} km</td>
                      <td className="num">{s.unitsToLoad}</td>
                      <td className="faint num" style={{ fontSize: 11.5 }}>
                        {s.picks.map((p) => `${p.slotCode}x${p.qty}`).join(' ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head"><h2>Recent runs</h2></div>
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th>Stops</th><th>Distance</th><th>Units</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r._id} className="clickable" onClick={() => setSelected(r)}>
                  <td>{r.name}</td>
                  <td><span className="tag">{r.status}</span></td>
                  <td className="num">{r.stops.length}</td>
                  <td className="num muted">{(r.totalMeters / 1000).toFixed(1)} km</td>
                  <td className="num">{r.totalUnits}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && <div className="empty">No runs planned yet.</div>}
        </section>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Route</h2></div>
        <div className="panel-body">
          <FleetMap machines={machines} route={selected} />
          <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>
            Dashed line is the planned visit order from the depot. Distances are great-circle,
            not road distance - this is a planning aid, not turn-by-turn navigation.
          </p>
        </div>
      </section>
    </div>
  );
}
