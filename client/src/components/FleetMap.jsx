import { useMemo } from 'react';

/**
 * Equirectangular projection of the fleet onto a fixed box.
 *
 * Deliberately not a tile map: no external tile requests, no API key, and at
 * city scale the distortion from ignoring the earth's curvature is invisible.
 * What matters operationally is relative position and status colour, and this
 * gives both while staying dependency-free.
 */
export default function FleetMap({ machines, route, selectedCode, onSelect }) {
  const { pins, path } = useMemo(() => {
    const points = machines.filter((m) => m.location?.coordinates?.length === 2);
    if (points.length === 0) return { pins: [], path: null };

    const lngs = points.map((m) => m.location.coordinates[0]);
    const lats = points.map((m) => m.location.coordinates[1]);
    // 8% padding so pins never sit on the border.
    const pad = 0.08;
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const spanLng = (maxLng - minLng) || 0.01;
    const spanLat = (maxLat - minLat) || 0.01;

    const project = ([lng, lat]) => ({
      x: (pad + ((lng - minLng) / spanLng) * (1 - 2 * pad)) * 100,
      // Latitude increases northward but CSS top increases downward - flip it.
      y: (pad + (1 - (lat - minLat) / spanLat) * (1 - 2 * pad)) * 100,
    });

    const pins = points.map((m) => ({ machine: m, ...project(m.location.coordinates) }));

    let path = null;
    if (route?.stops?.length) {
      const coords = [
        route.depot?.coordinates,
        ...route.stops.map((s) => s.location?.coordinates),
      ].filter(Boolean);
      path = coords.map(project).map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    }

    return { pins, path };
  }, [machines, route]);

  if (pins.length === 0) return <div className="empty">No machines with coordinates.</div>;

  return (
    <div className="map">
      <div className="map-grid" />

      {path && (
        <svg className="map-route" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={path} fill="none" stroke="var(--signal)" strokeWidth="0.5"
                strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" opacity="0.85" />
        </svg>
      )}

      {pins.map(({ machine, x, y }) => (
        <button
          key={machine.code}
          className={`pin ${machine.status}`}
          style={{
            left: `${x}%`,
            top: `${y}%`,
            outline: machine.code === selectedCode ? '2px solid var(--signal)' : 'none',
            outlineOffset: '2px',
            padding: 0,
          }}
          title={`${machine.code} - ${machine.siteName} (${machine.status})`}
          onClick={() => onSelect?.(machine.code)}
          aria-label={`${machine.code}, ${machine.siteName}, ${machine.status}`}
        />
      ))}
    </div>
  );
}
