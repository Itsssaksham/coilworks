import { Machine } from '../models/Machine.js';

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres between two [lng, lat] points.
 * Used for route legs after $geoNear has done the index-backed selection.
 */
export function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Machines nearest a point, with the distance computed by MongoDB.
 *
 * $geoNear must be the first stage of the pipeline and uses the 2dsphere index
 * on Machine.location - it does not scan the collection and sort afterwards.
 */
export async function nearestMachines({ coordinates, maxMeters = 50_000, limit = 25, filter = {} }) {
  return Machine.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates },
        distanceField: 'distanceMeters',
        maxDistance: maxMeters,
        spherical: true,
        query: filter, // applied inside the index scan, not after it
      },
    },
    { $limit: limit },
    {
      $project: {
        code: 1, name: 1, siteName: 1, address: 1, location: 1,
        status: 1, lastSeenAt: 1, slots: 1, distanceMeters: 1,
      },
    },
  ]);
}

/**
 * Orders stops into a route with nearest-neighbour from the depot, then improves
 * it with 2-opt.
 *
 * Nearest-neighbour alone is fast but leaves crossings - it commits to a cheap
 * early hop and pays for it on the return leg. 2-opt repeatedly reverses the
 * segment between two stops when doing so shortens the tour, which removes
 * exactly those crossings. For the 10-40 stops on a service round this runs in
 * microseconds and typically cuts 10-25% off the nearest-neighbour distance.
 *
 * This is a planning aid over straight-line distance, not turn-by-turn routing:
 * there is no road network here.
 */
export function planRoute({ depot, stops }) {
  if (stops.length === 0) return { ordered: [], totalMeters: 0 };

  const remaining = [...stops];
  const ordered = [];
  let cursor = depot;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(cursor, remaining[i].location.coordinates);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    cursor = next.location.coordinates;
  }

  const improved = twoOpt(depot, ordered);
  return { ordered: improved, totalMeters: tourLength(depot, improved) };
}

/** Total path length: depot -> each stop in order. Does not return to depot. */
function tourLength(depot, stops) {
  let total = 0;
  let cursor = depot;
  for (const s of stops) {
    total += haversineMeters(cursor, s.location.coordinates);
    cursor = s.location.coordinates;
  }
  return total;
}

/**
 * 2-opt: for every pair (i, k), reverse stops[i..k] and keep the reversal if the
 * tour got shorter. Repeat until a full pass makes no improvement.
 */
function twoOpt(depot, stops, maxPasses = 40) {
  let best = [...stops];
  let bestLen = tourLength(depot, best);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improvedThisPass = false;

    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const len = tourLength(depot, candidate);
        if (len < bestLen - 0.5) { // 0.5m guard against float churn
          best = candidate;
          bestLen = len;
          improvedThisPass = true;
        }
      }
    }

    if (!improvedThisPass) break;
  }

  return best;
}
