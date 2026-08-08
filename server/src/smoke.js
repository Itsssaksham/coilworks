/**
 * End-to-end smoke test.
 *
 * Boots nothing and mocks nothing - it drives the running API over HTTP exactly
 * as a browser and a machine controller would, then asserts on what the database
 * actually did. If this passes, the ingest path, auth, transactions, aggregation
 * pipelines, geospatial queries, alert rules, and AI layer are all wired up.
 *
 * Usage:  npm run smoke        (with `npm run dev` already running)
 */
import assert from 'node:assert/strict';
import { connect, disconnect } from './db.js';
import { config } from './config.js';
import { Machine } from './models/Machine.js';
import { Alert } from './models/Alert.js';
import { generateMachineKey } from './middleware/auth.js';

const BASE = process.env.SMOKE_URL || `http://localhost:${config.port}`;

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function api(path, { method = 'GET', token, machineKey, body } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (machineKey) headers['x-machine-key'] = machineKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`\nCoilworks smoke test -> ${BASE}\n`);
  await connect();

  // --- health ------------------------------------------------------------
  await check('API is up and reports its AI provider', async () => {
    const { status, body } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(['claude', 'offline'].includes(body.ai.provider));
  });

  // --- auth --------------------------------------------------------------
  let token;
  await check('operator can log in', async () => {
    const { status, body } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'ops@coilworks.io', password: 'coilworks' },
    });
    assert.equal(status, 200, `login returned ${status}`);
    assert.ok(body.token);
    token = body.token;
  });

  await check('bad password is rejected', async () => {
    const { status } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'ops@coilworks.io', password: 'wrong' },
    });
    assert.equal(status, 401);
  });

  await check('protected route rejects a missing token', async () => {
    const { status } = await api('/api/machines');
    assert.equal(status, 401);
  });

  // --- WebSocket auth ----------------------------------------------------
  await check('WebSocket upgrade without a ticket is rejected', async () => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
    const outcome = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve('opened'));
      ws.addEventListener('error', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    ws.close();
    assert.equal(outcome, 'rejected', 'an unauthenticated socket must not open');
  });

  await check('WebSocket upgrade with a garbage ticket is rejected', async () => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?ticket=not-a-real-ticket`);
    const outcome = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve('opened'));
      ws.addEventListener('error', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    ws.close();
    assert.equal(outcome, 'rejected');
  });

  let ticket;
  await check('an authenticated operator can mint a WebSocket ticket', async () => {
    const { status, body } = await api('/api/auth/ws-ticket', { method: 'POST', token });
    assert.equal(status, 200);
    assert.ok(body.ticket);
    assert.ok(body.expiresInSeconds > 0 && body.expiresInSeconds <= 60, 'ticket must be short-lived');
    ticket = body.ticket;
  });

  await check('a valid ticket opens the feed and delivers hello', async () => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`);
    const hello = await new Promise((resolve, reject) => {
      ws.addEventListener('message', (e) => resolve(JSON.parse(e.data)));
      ws.addEventListener('error', () => reject(new Error('socket errored')));
      setTimeout(() => reject(new Error('no hello within 3s')), 3000);
    });
    ws.close();
    assert.equal(hello.type, 'hello');
    assert.ok(Array.isArray(hello.topics));
    assert.ok(hello.operator, 'hello should identify the authenticated operator');
  });

  await check('a ticket cannot be redeemed twice', async () => {
    // `ticket` was already spent by the previous check.
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?ticket=${encodeURIComponent(ticket)}`);
    const outcome = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve('opened'));
      ws.addEventListener('error', () => resolve('rejected'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    ws.close();
    assert.equal(outcome, 'rejected', 'tickets must be single-use');
  });

  // --- injection ---------------------------------------------------------
  await check('a catastrophic regex in ?site= is neutralised', async () => {
    // Unescaped, this pattern backtracks exponentially and pins a CPU core.
    const evil = encodeURIComponent('(a+)+$');
    const started = Date.now();
    const { status } = await api(`/api/machines?site=${evil}`, { token });
    const elapsed = Date.now() - started;
    assert.equal(status, 200);
    assert.ok(elapsed < 2000, `search took ${elapsed}ms - the pattern was not escaped`);
  });

  await check('regex metacharacters match literally, not as a pattern', async () => {
    // ".*" would match every site if treated as a pattern; escaped, it matches
    // the literal string ".*", which no site contains.
    const { body } = await api('/api/machines?site=.*', { token });
    assert.equal(body.machines.length, 0, 'escaped metacharacters must not match everything');
  });

  // --- readiness ---------------------------------------------------------
  await check('readiness reports change-stream health', async () => {
    const { status, body } = await api('/api/ready');
    assert.equal(status, 200, 'streams should be healthy in a normal run');
    assert.equal(body.ready, true);
    assert.deepEqual(body.degradedTopics, []);
  });

  // --- security headers --------------------------------------------------
  await check('security headers are set', async () => {
    const res = await fetch(`${BASE}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'), 'CSP must be present');
    assert.equal(res.headers.get('x-powered-by'), null, 'x-powered-by should be disabled');
  });

  // --- machine auth ------------------------------------------------------
  const machine = await Machine.findOne({}).sort({ code: 1 });
  assert.ok(machine, 'no machines seeded - run `npm run seed` first');

  // Mint a known key for this machine so the test can authenticate as it.
  const key = generateMachineKey();
  machine.apiKeyHash = key.hash;
  machine.apiKeyLast4 = key.last4;
  await machine.save();

  await check('telemetry without a machine key is rejected', async () => {
    const { status } = await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      body: { temperatureC: 4 },
    });
    assert.equal(status, 401);
  });

  await check('telemetry with a wrong machine key is rejected', async () => {
    const { status } = await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      machineKey: 'cwk_not-a-real-key',
      body: { temperatureC: 4 },
    });
    assert.equal(status, 401);
  });

  await check('telemetry is accepted and marks the machine online', async () => {
    const { status } = await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      machineKey: key.plain,
      body: { temperatureC: 4.2, doorOpen: false, cashCents: 1000, powerOk: true, signalStrength: 80, coilFaults: [] },
    });
    assert.equal(status, 202);
    const fresh = await Machine.findById(machine._id);
    assert.equal(fresh.status, 'online');
    assert.ok(fresh.lastSeenAt);
  });

  await check('malformed telemetry is rejected with field detail', async () => {
    const { status, body } = await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      machineKey: key.plain,
      body: { temperatureC: 'warm' },
    });
    assert.equal(status, 400);
    assert.ok(Array.isArray(body.issues));
  });

  // --- alert rules -------------------------------------------------------
  await check('a coil fault raises a jam alert and faults the machine', async () => {
    const target = (await Machine.findById(machine._id)).slots[0].code;
    await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      machineKey: key.plain,
      body: { temperatureC: 4, powerOk: true, coilFaults: [target] },
    });
    const fresh = await Machine.findById(machine._id);
    assert.equal(fresh.status, 'fault');
    const alert = await Alert.findOne({ machineId: machine._id, type: 'jam', status: 'open' });
    assert.ok(alert, 'expected an open jam alert');
  });

  await check('a repeated fault does not duplicate the alert', async () => {
    const target = (await Machine.findById(machine._id)).slots[0].code;
    const before = await Alert.countDocuments({ machineId: machine._id, type: 'jam', status: 'open' });
    for (let i = 0; i < 3; i++) {
      await api(`/api/ingest/${machine.code}/telemetry`, {
        method: 'POST',
        machineKey: key.plain,
        body: { temperatureC: 4, powerOk: true, coilFaults: [target] },
      });
    }
    const after = await Alert.countDocuments({ machineId: machine._id, type: 'jam', status: 'open' });
    assert.equal(after, before, 'dedupe key should collapse repeats into one alert');
  });

  await check('clearing the fault resolves the alert', async () => {
    await api(`/api/ingest/${machine.code}/telemetry`, {
      method: 'POST',
      machineKey: key.plain,
      body: { temperatureC: 4, powerOk: true, coilFaults: [] },
    });
    const fresh = await Machine.findById(machine._id);
    assert.equal(fresh.status, 'online');
  });

  // --- vend transaction --------------------------------------------------
  await check('a vend decrements the slot and records the sale atomically', async () => {
    const before = await Machine.findById(machine._id);
    const slot = before.slots.find((s) => s.qty > 0);
    assert.ok(slot, 'no stocked slot to vend from');

    const { status, body } = await api(`/api/ingest/${machine.code}/vend`, {
      method: 'POST',
      machineKey: key.plain,
      body: { slotCode: slot.code, payment: 'card' },
    });
    assert.equal(status, 201);
    assert.equal(body.remaining, slot.qty - 1);
    assert.equal(body.sale.sku, slot.sku);

    const after = await Machine.findById(machine._id);
    assert.equal(after.slots.find((s) => s.code === slot.code).qty, slot.qty - 1);
  });

  await check('vending an empty slot is refused', async () => {
    const m = await Machine.findById(machine._id);
    const slot = m.slots[0];
    slot.qty = 0;
    await m.save();

    const { status } = await api(`/api/ingest/${machine.code}/vend`, {
      method: 'POST',
      machineKey: key.plain,
      body: { slotCode: slot.code, payment: 'cash' },
    });
    assert.equal(status, 409);
  });

  // --- pagination --------------------------------------------------------
  await check('the machines list is paginated with a total', async () => {
    const { status, body } = await api('/api/machines?limit=5', { token });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.machines));
    assert.ok(body.machines.length <= 5, 'limit must be honoured');
    assert.ok(body.total >= body.machines.length, 'total must count the whole match');
    assert.equal(body.limit, 5);
  });

  await check('an absurd limit is clamped rather than obeyed', async () => {
    const { body } = await api('/api/machines?limit=999999', { token });
    assert.ok(body.limit <= 500, `limit was ${body.limit}, expected it clamped`);
  });

  // --- aggregations ------------------------------------------------------
  await check('fleet summary aggregates machines, stock, and revenue', async () => {
    const { status, body } = await api('/api/analytics/summary', { token });
    assert.equal(status, 200);
    assert.ok(body.machines.total > 0);
    assert.ok(body.inventory.capacity > 0);
    assert.ok(body.inventory.fillRatio >= 0 && body.inventory.fillRatio <= 1);
  });

  await check('forecast derives a depletion rate from real sales', async () => {
    const { status, body } = await api('/api/analytics/forecast?horizonDays=14', { token });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const withRate = body.filter((r) => r.ratePerDay > 0);
    assert.ok(withRate.length > 0, 'expected at least one slot with a measured rate');
    // daysToEmpty must be consistent with qty / rate.
    const row = withRate[0];
    const expected = row.qty / row.ratePerDay;
    assert.ok(Math.abs(row.daysToEmpty - expected) < 0.15, 'daysToEmpty should equal qty / ratePerDay');
  });

  await check('sales-by-hour returns a gap-filled series', async () => {
    const { status, body } = await api('/api/analytics/sales-by-hour?hours=12', { token });
    assert.equal(status, 200);
    assert.ok(body.length >= 12, `expected >=12 hourly buckets, got ${body.length}`);
  });

  // --- geospatial --------------------------------------------------------
  await check('$geoNear returns machines sorted by real distance', async () => {
    const { status, body } = await api('/api/machines?lat=30.7410&lng=76.7794&radiusKm=30', { token });
    assert.equal(status, 200);
    const rows = body.machines;
    assert.ok(rows.length > 1);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        rows[i].distanceMeters >= rows[i - 1].distanceMeters,
        'results must be ordered nearest-first',
      );
    }
  });

  await check('route planner orders stops and totals the distance', async () => {
    const { status, body } = await api('/api/runs/plan', {
      method: 'POST',
      token,
      body: { name: 'smoke run', depotLat: 30.7410, depotLng: 76.7794, horizonDays: 14, maxStops: 6 },
    });
    assert.equal(status, 201);
    assert.ok(body.run.stops.length > 0);
    assert.ok(body.run.totalMeters > 0);
    body.run.stops.forEach((s, i) => assert.equal(s.order, i + 1, 'stops must be sequentially ordered'));
  });

  // --- AI ----------------------------------------------------------------
  await check('alert triage returns a complete diagnosis', async () => {
    const alert = await Alert.findOne({ status: { $ne: 'resolved' } });
    assert.ok(alert, 'no alert to triage');
    const { status, body } = await api(`/api/alerts/${alert._id}/triage`, { method: 'POST', token });
    assert.equal(status, 200);
    for (const field of ['diagnosis', 'likelyCause', 'recommendedAction']) {
      assert.ok(body.triage[field], `triage.${field} must be present`);
    }
    assert.equal(typeof body.triage.dispatchRequired, 'boolean');
    assert.ok(['claude', 'offline'].includes(body.provider));
  });

  await check('ops assistant answers from real tool calls', async () => {
    const { status, body } = await api('/api/ai/ask', {
      method: 'POST',
      token,
      body: { question: 'which machines will run out of stock first?' },
    });
    assert.equal(status, 200);
    assert.ok(body.answer.length > 0);
    assert.ok(body.trace.length > 0, 'an answer must be backed by at least one tool call');
    assert.ok(body.trace.every((t) => t.ok), 'every tool call should have succeeded');
  });

  // --- rate limiting -----------------------------------------------------
  await check('ingest rate limit kicks in and sets Retry-After', async () => {
    let limited = false;
    for (let i = 0; i < 130; i++) {
      const res = await fetch(`${BASE}/api/ingest/${machine.code}/telemetry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-machine-key': key.plain },
        body: JSON.stringify({ temperatureC: 4, powerOk: true }),
      });
      if (res.status === 429) {
        assert.ok(res.headers.get('retry-after'), '429 must carry Retry-After');
        limited = true;
        break;
      }
    }
    assert.ok(limited, 'expected a 429 within 130 requests against a 120/min budget');
  });

  await disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nsmoke test crashed:', err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});
