# COILWORKS

**A vending fleet operations platform.** Machines report telemetry; the platform
turns that into live fleet state, alerts with AI triage, depletion forecasts, and
route-ordered restock runs.

Built on the MERN stack — MongoDB, Express, React, Node.js — with MongoDB doing
real work rather than acting as a document bucket: time-series collections for
telemetry, `2dsphere` geospatial indexes for routing, aggregation pipelines for
forecasting, change streams for the live UI, and transactions for vends.

> **There is no vending hardware here.** A simulator (`npm run simulate`) plays
> the role of the fleet's machine controllers, talking to the same authenticated
> ingest API a physical machine would. Everything downstream of it is the real
> system. Nothing in the UI is mocked.

---

## Quick start

Requires **Node 20+** and **MongoDB** as a replica set (change streams and
transactions need an oplog, which a standalone `mongod` does not have).

```bash
npm install
```

Start MongoDB — either path works:

```bash
docker compose up -d
```

```powershell
# No Docker? Runs a second mongod on port 27018 with its own data directory.
# Your existing MongoDB service on 27017 is left alone.
./scripts/mongo-dev.ps1
```

Then seed and run:

```bash
npm run seed
```

```bash
npm run dev
```

Open <http://localhost:5173> and sign in as `viewer@coilworks.io` / `coilworks`.

The seed creates three accounts. Only the read-only one has a password in this
repository — the two write-capable accounts get generated passwords, printed
once when you seed:

| Account | Role | Can |
|---|---|---|
| `viewer@coilworks.io` | viewer | read everything, run AI triage, ask the assistant |
| `dispatch@coilworks.io` | dispatcher | the above, plus restock, alerts, planning runs |
| `ops@coilworks.io` | admin | the above, plus provisioning machines and minting keys |

Set `DEMO_ADMIN_PASSWORD` and `DEMO_DISPATCH_PASSWORD` before seeding to choose
your own. The viewer credential is public deliberately: it is what you hand out
with a demo link, and the role cannot change anything, so publishing it costs
nothing.

In a second terminal, bring the fleet to life:

```bash
npm run simulate -- --scenarios
```

Within seconds the dashboard shows machines coming online, sales landing, stock
draining, and — because `--scenarios` scripts them — a chiller failing, a coil
jamming, and a machine dropping off the network.

### Verify it end to end

```bash
npm run smoke
```

40 checks against the running API: operator and machine-key auth, WebSocket
ticket auth (including single-use enforcement), regex-injection resistance,
ingest validation, alert dedupe, vend transactions, pagination clamps,
aggregation correctness, geospatial ordering, route planning, AI triage,
security headers, readiness, and rate limiting.

### Run it as one process

```bash
npm run build && npm start
```

Express serves the built SPA alongside the API on a single port, which is how it
runs in a container. Or build the image:

```bash
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))") docker compose --profile app up --build
```

---

## What it does

**Live fleet state.** Every machine's status, fill level, cabinet temperature,
cash box, and signal — updated the moment a heartbeat lands. The dashboard has
no polling anywhere in it.

**Alerting.** Rules over the telemetry stream raise stockouts, low stock, coil
jams, chiller drift, power loss, cash-box-full, and offline machines. Alerts
dedupe, so a slot that stays low is one alert, not one per heartbeat.

**AI fault triage.** One click on an alert returns a diagnosis, likely cause,
recommended action, and a dispatch-or-not call, grounded in that machine's recent
telemetry.

**Depletion forecasting.** Measures each slot's real sales rate and projects when
it hits zero — the basis for deciding what to restock and when.

**Restock routing.** Builds a run from the forecast (machines that will actually
run out), then orders the stops into a route from the depot with a pick list per
stop.

**Ops assistant.** Ask "which machines will run out first?" in English. The model
answers by calling read-only tools against the live database, and the UI shows
every query it ran.

---

## Architecture

```
      simulated machines (or real controllers)
                    |
                    |  POST /api/ingest/:code/telemetry     X-Machine-Key
                    |  POST /api/ingest/:code/vend          per-machine, hashed
                    v
        +-----------------------------+
        |  Express API (Node)         |
        |   auth, validation, limits  |
        |   alert rules engine        |
        |   aggregation + geo queries |
        |   Claude tool-use agent     |
        +--------------+--------------+
                       |
                       v
        +-----------------------------+          change streams
        |  MongoDB (replica set)      |  ------------------------+
        |   machines   2dsphere       |                          |
        |   telemetry  time-series    |                          v
        |   sales      transactions   |              +------------------------+
        |   alerts     partial index  |              |  WebSocket hub         |
        +-----------------------------+              +-----------+------------+
                                                                 |
                                                                 v
                                                     React dashboard (Vite)
                                                     no polling, ever
```

### Why MongoDB needs to be a replica set

Two features depend on the oplog, and both are load-bearing:

- **Change streams** drive the live dashboard. MongoDB tails its own oplog and
  pushes to the WebSocket hub, so a machine's heartbeat reaches every open
  browser in one hop.
- **Transactions** make a vend atomic. Decrementing a slot and writing the sale
  must both happen or neither — a decrement without a sale loses revenue data,
  and a sale without a decrement makes the forecast believe in stock that isn't
  there.

`server/src/db.js` checks for a replica set at boot and fails with a clear
message rather than letting the dashboard sit silently empty.

---

## The parts worth reading

| Area | File | What's interesting |
|---|---|---|
| Depletion forecast | `server/src/services/forecast.js` | One aggregation instead of a query per slot: `$unwind` the planogram, correlate each slot with its own sales through a `$lookup` pipeline, derive rate and days-to-empty in `$project`. |
| Route planning | `server/src/services/geo.js` | `$geoNear` for index-backed selection, then nearest-neighbour ordering improved with 2-opt — which removes the crossings nearest-neighbour leaves behind, typically cutting 10-25% off the tour. |
| Alert dedupe | `server/src/services/alerts.js` | A dedupe key plus a **partial unique index** scoped to open alerts, so the same fault can legitimately recur later but cannot pile up now. Two concurrent ingests can't both win. |
| Vend atomicity | `server/src/routes/ingest.js` | `session.withTransaction` around the slot decrement and the sale insert. Alert evaluation runs *outside* it, so a failed alert write can't roll back a sale that physically happened. |
| Telemetry storage | `server/src/models/Telemetry.js` | Native time-series collection: bucketed by machine, columnar, TTL expiry with no cleanup job. Comes with real constraints — append-only, no per-document deletes. |
| Live fan-out | `server/src/realtime/hub.js` | Change streams to WebSocket, with per-topic subscriptions, `updateLookup` so clients render without a follow-up fetch, and ping/pong reaping of half-open sockets. |
| AI tool surface | `server/src/services/llm/tools.js` | Six read-only tools. The assistant can answer anything about the fleet and change nothing, so a prompt-injected answer can mislead a reader but cannot touch fleet state. |
| Agentic loop | `server/src/services/llm/assistant.js` | Hand-written tool-use loop with a turn cap, parallel tool execution returned in a single message, and the full trace surfaced to the UI. |
| WebSocket auth | `server/src/realtime/tickets.js` | Browsers can't set headers on a WS handshake, so the credential must ride in the URL — and URLs reach proxy logs and history. Single-use 30-second tickets make a leaked one worthless. |
| Boot validation | `server/src/config.js` | Refuses to start in production with the repo's own default JWT secret or an empty CORS allowlist. Reports every problem at once, and separates hard errors from "usually wrong" warnings. |

---

## Production readiness

The security and deployment work is done; the scaling work is not. Both are
stated plainly rather than implied.

**Done.** Every WebSocket connection is authenticated. Write access is a server-
enforced role boundary, so the public demo login can explore the entire fleet
and change none of it — the UI hides those controls, but the guard that matters
is `requireWriteAccess` on the route, and the smoke suite proves it by attempting
each mutation as a viewer. No write-capable password exists in this repository.
All user- and model-supplied search input is regex-escaped. Production refuses to
boot with an unsafe secret or an open CORS policy. Change streams resume from a token after a
failure and, when they can't, the dashboard says *stale* instead of showing a
green light over frozen numbers. Security headers and a strict CSP are set,
`x-powered-by` is off. List endpoints are paginated with clamped limits. Indexes
are synced deliberately rather than rebuilt on every boot. Logs are JSON in
production. Express serves the SPA, so the whole app is one process and one
container image running as a non-root user with a healthcheck.

**Not done — this runs on one instance.** WebSocket fan-out and rate limiting are
both in-process, so two replicas behind a load balancer would drop events for
half the clients and divide the rate limits per instance. Moving both to Redis
pub/sub is the next real piece of work.

**Also outstanding:** JWTs can't be revoked before expiry (no refresh-token
rotation or denylist); there are no metrics or tracing; there is no backup or
restore procedure; and there are no unit tests — the smoke test covers the paths
end to end, but the geospatial and forecast maths deserve their own.

---

## AI layer

Uses the Anthropic SDK with **Claude Opus 5**.

**Two features.** *Fault triage* constrains the model to a JSON schema so the
result is a typed object, not hopefully-parsed prose, and caches onto the alert
so reopening it costs nothing. *The ops assistant* runs an agentic tool-use loop
over six read-only database tools.

**It runs with no API key.** Without `ANTHROPIC_API_KEY` both features fall back
to a deterministic rule-based analyzer in `services/llm/offline.js`. That is not
a language model and the UI says so on every result — the point is that the whole
product works, with real data, at zero spend, and that the smoke test can assert
on exact output.

**Effort is tuned per feature, and thinking stays on.** Triage runs at `low`,
the assistant at `medium`. Disabling thinking looks cheaper but has a specific
failure mode with tool use: the model can write a tool call into its visible text
instead of emitting a `tool_use` block, which completes the turn successfully
while silently never running the tool.

```bash
# Optional — switches both features from the offline analyzer to Claude.
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

---

## API

Machine-facing, authenticated per machine with a hashed API key:

| | |
|---|---|
| `POST /api/ingest/:code/telemetry` | one heartbeat |
| `POST /api/ingest/:code/vend` | a completed sale |

Operator-facing, authenticated with a JWT:

| | |
|---|---|
| `POST /api/auth/login` | |
| `GET  /api/machines` | fleet list, or `?lat=&lng=&radiusKm=` for nearest-first |
| `GET  /api/machines/:code` | detail, planogram, alerts, telemetry |
| `POST /api/machines/:code/restock` | record units loaded |
| `GET  /api/alerts` | the queue |
| `POST /api/alerts/:id/triage` | AI diagnosis |
| `GET  /api/analytics/summary` | KPI row |
| `GET  /api/analytics/forecast` | projected stockouts |
| `POST /api/runs/plan` | build a route-ordered restock run |
| `POST /api/ai/ask` | ops assistant |
| `WS   /ws` | live machine, alert, and sale events |

---

## Known limitations

Design limits, separate from the deployment gaps above:

- **Distances are great-circle, not road distance.** The route planner is a
  planning aid; it has no road network and does not do turn-by-turn navigation.
- **The forecast assumes a stable sales rate.** It measures a trailing window and
  projects it forward, so it will not anticipate a holiday spike or a site
  closure.
- **Machine keys are re-minted by the simulator.** Keys are stored hashed and are
  unrecoverable by design, so the simulator mints its own on startup. That is
  safe for a local dev tool and would not belong in production.
- **Telemetry retention is fixed at creation.** `expireAfterSeconds` is set when
  the time-series collection is created; changing the env var later does not
  alter an existing collection (it needs a `collMod`).
