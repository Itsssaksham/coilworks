import { connect, disconnect } from './db.js';
import { config } from './config.js';
import { Machine } from './models/Machine.js';
import { generateMachineKey } from './middleware/auth.js';

/**
 * Fleet simulator - stands in for real vending hardware.
 *
 * THERE IS NO REAL HARDWARE HERE. This process pretends to be the fleet's
 * machine controllers: it heartbeats telemetry, rings up sales, and drifts into
 * faults on a schedule. Everything downstream of it - ingest, alert rules,
 * change streams, the dashboard - is the real system doing real work.
 *
 * It deliberately talks to the API over authenticated HTTP rather than writing
 * to MongoDB directly, so it exercises the same ingest path, auth, validation,
 * and rate limiting that a physical machine would hit.
 *
 * Machine API keys are stored hashed and are unrecoverable, so on startup the
 * simulator re-mints a key for each machine it drives and writes back the new
 * hash. That is safe here because it is a local development tool.
 *
 * Usage:  npm run simulate -- --rate 2000 --scenarios
 */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const TICK_MS = Number(flag('rate', 2000));
const BASE_URL = flag('url', `http://localhost:${config.port}`);
const RUN_SCENARIOS = has('scenarios');

function rng(seed = 0xc01) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng();

/** Per-machine simulation state, held in memory for the life of the process. */
const state = new Map();

async function post(path, key, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-machine-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 409) {
    // 409 = slot empty on a vend, which is a legitimate outcome, not an error.
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.status === 409 ? null : res.json();
}

async function bootstrap() {
  await connect();
  const machines = await Machine.find({});
  if (machines.length === 0) {
    throw new Error('No machines in the database. Run `npm run seed` first.');
  }

  for (const machine of machines) {
    const key = generateMachineKey();
    machine.apiKeyHash = key.hash;
    machine.apiKeyLast4 = key.last4;
    await machine.save();

    const chilled = !machine.model.includes('Ambient');
    state.set(machine.code, {
      code: machine.code,
      key: key.plain,
      chilled,
      // Chilled cabinets sit around 4C, ambient ones track room temperature.
      temperatureC: chilled ? 3.5 + random() : 23 + random() * 2,
      cashCents: machine.cashCents,
      cashCapacityCents: machine.cashCapacityCents,
      signalStrength: machine.signalStrength ?? 70,
      powerOk: true,
      coilFaults: [],
      offline: false, // when true the machine stops heartbeating entirely
      footfall: 0.3 + random() * 1.5,
      uptimeSeconds: Math.floor(random() * 500_000),
      slots: machine.slots.map((s) => ({ code: s.code, qty: s.qty })),
    });
  }

  console.log(`[sim] driving ${state.size} machines against ${BASE_URL} every ${TICK_MS}ms`);
  console.log('[sim] NOTE: simulated hardware. No physical machines are involved.');
  return machines;
}

/** Advance one machine's physical state by one tick. */
function stepPhysics(sim) {
  // Temperature random-walks toward its setpoint.
  const setpoint = sim.chilled ? 4 : 23;
  sim.temperatureC += (setpoint - sim.temperatureC) * 0.12 + (random() - 0.5) * 0.25;

  // Signal drifts within a band.
  sim.signalStrength = Math.max(5, Math.min(100, sim.signalStrength + (random() - 0.5) * 6));

  sim.uptimeSeconds += Math.round(TICK_MS / 1000);

  // A door is opened occasionally (a customer, or a service visit).
  sim.doorOpen = random() < 0.03;
}

/** One heartbeat + zero or more vends for one machine. */
async function tickMachine(sim) {
  if (sim.offline) return; // an offline machine sends nothing - that's the point

  stepPhysics(sim);

  await post(`/api/ingest/${sim.code}/telemetry`, sim.key, {
    temperatureC: Number(sim.temperatureC.toFixed(2)),
    doorOpen: sim.doorOpen,
    cashCents: sim.cashCents,
    powerOk: sim.powerOk,
    signalStrength: Math.round(sim.signalStrength),
    coilFaults: sim.coilFaults,
    uptimeSeconds: sim.uptimeSeconds,
  });

  // Vends are Poisson-ish: usually none per tick, sometimes one or two.
  const expected = sim.footfall * (TICK_MS / 4000);
  let vends = Math.floor(expected);
  if (random() < expected % 1) vends += 1;

  for (let i = 0; i < vends; i++) {
    const stocked = sim.slots.filter((s) => s.qty > 0 && !sim.coilFaults.includes(s.code));
    if (stocked.length === 0) break;

    const slot = stocked[Math.floor(random() * stocked.length)];
    const payment = random() < 0.62 ? 'card' : random() < 0.7 ? 'mobile' : 'cash';

    const result = await post(`/api/ingest/${sim.code}/vend`, sim.key, {
      slotCode: slot.code,
      payment,
    });

    if (result) {
      slot.qty = result.remaining;
      if (payment === 'cash') sim.cashCents += result.sale.priceCents;
    }
  }
}

/**
 * Scripted faults, so a demo shows the alert pipeline working instead of
 * waiting for one to happen by chance. Each scenario fires once, at a fixed
 * tick, against a fixed machine.
 */
function scenarioFor(tick, machines) {
  const pick = (n) => machines[n % machines.length];

  switch (tick) {
    case 8: {
      const sim = state.get(pick(2).code);
      if (sim?.chilled) {
        console.log(`[sim] SCENARIO: chiller failing on ${sim.code}`);
        sim.chillerFailed = true;
      }
      return;
    }
    case 14: {
      const sim = state.get(pick(5).code);
      if (sim) {
        const slot = sim.slots[Math.floor(random() * sim.slots.length)];
        console.log(`[sim] SCENARIO: coil jam on ${sim.code} slot ${slot.code}`);
        sim.coilFaults = [slot.code];
      }
      return;
    }
    case 22: {
      const sim = state.get(pick(7).code);
      if (sim) {
        console.log(`[sim] SCENARIO: ${sim.code} dropped off the network`);
        sim.offline = true;
      }
      return;
    }
    case 30: {
      const sim = state.get(pick(3).code);
      if (sim) {
        console.log(`[sim] SCENARIO: mains power lost at ${sim.code}`);
        sim.powerOk = false;
      }
      return;
    }
    default:
      return;
  }
}

async function main() {
  const machines = await bootstrap();
  let tick = 0;

  const timer = setInterval(async () => {
    tick += 1;
    if (RUN_SCENARIOS) scenarioFor(tick, machines);

    // A failed chiller keeps climbing past the alert threshold.
    for (const sim of state.values()) {
      if (sim.chillerFailed) sim.temperatureC += 0.4 + random() * 0.3;
    }

    const results = await Promise.allSettled([...state.values()].map(tickMachine));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(`[sim] tick ${tick}: ${failed.length} machine(s) failed - ${failed[0].reason.message}`);
    } else if (tick % 10 === 0) {
      const live = [...state.values()].filter((s) => !s.offline).length;
      console.log(`[sim] tick ${tick} - ${live}/${state.size} machines reporting`);
    }
  }, TICK_MS);

  const stop = async () => {
    clearInterval(timer);
    await disconnect();
    console.log('\n[sim] stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (err) => {
  console.error('[sim] failed:', err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});
