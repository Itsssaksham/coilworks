/**
 * Hand-rolled SVG area chart.
 *
 * A charting library would be several hundred KB for one sparkline; this is a
 * path built from the data and scales to the container. No dependencies.
 */
export default function Chart({ points, height = 130, valueKey = 'units', label }) {
  if (!points || points.length === 0) {
    return <div className="empty">No data in this window.</div>;
  }

  const W = 600;
  const H = height;
  const pad = { top: 8, right: 4, bottom: 16, left: 4 };

  const values = points.map((p) => p[valueKey] ?? 0);
  const max = Math.max(1, ...values);
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const x = (i) => pad.left + (i / Math.max(1, points.length - 1)) * innerW;
  const y = (v) => pad.top + innerH - (v / max) * innerH;

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)},${(pad.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + innerH).toFixed(1)} Z`;

  const firstLabel = new Date(points[0].hour).toLocaleTimeString([], { hour: 'numeric' });
  const lastLabel = new Date(points.at(-1).hour).toLocaleTimeString([], { hour: 'numeric' });

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
         aria-label={`${label ?? valueKey} over time, peak ${max}`}>
      <line className="axis" x1={pad.left} y1={pad.top + innerH} x2={W - pad.right} y2={pad.top + innerH} />
      <path className="area" d={area} />
      <path className="line" d={line} />
      <text x={pad.left} y={H - 3} fill="#6f6862" fontSize="10" fontFamily="ui-monospace, monospace">{firstLabel}</text>
      <text x={W - pad.right} y={H - 3} fill="#6f6862" fontSize="10" textAnchor="end" fontFamily="ui-monospace, monospace">{lastLabel}</text>
      <text x={pad.left} y={pad.top + 8} fill="#6f6862" fontSize="10" fontFamily="ui-monospace, monospace">peak {max}</text>
    </svg>
  );
}
