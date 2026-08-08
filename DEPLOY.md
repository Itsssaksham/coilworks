# Deploying Coilworks

Everything here is free and needs no card. Budget about 15 minutes.

The one non-obvious requirement: **MongoDB must be a replica set.** Coilworks
uses change streams (the live dashboard) and transactions (atomic vends), and
both need an oplog. A single `mongod` will not do — the app checks at boot and
refuses to start with a clear message rather than silently serving a dead
dashboard. MongoDB Atlas gives you a replica set on its free tier, which is why
these instructions use it.

---

## 1. MongoDB Atlas (the database)

1. Create a free account at <https://www.mongodb.com/cloud/atlas/register>.
2. **Build a Database → M0 (Free)**. Pick the region closest to your app host.
3. **Database Access → Add New Database User.** Username and password, note both.
   Use "Read and write to any database".
4. **Network Access → Add IP Address.** Render assigns dynamic egress IPs on the
   free plan, so allow `0.0.0.0/0`. The database is still protected by the user
   password; on a paid plan you would restrict this to Render's static IPs.
5. **Connect → Drivers → Node.js** and copy the connection string. It looks like:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

   Add the database name before the `?`:

   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/coilworks?retryWrites=true&w=majority
   ```

   > `mongodb+srv://` resolves the replica set members through DNS, so you do
   > **not** add `replicaSet=` or `directConnection=` the way the local
   > development URI does.

---

## 2. Render (the app)

1. Create a free account at <https://dashboard.render.com/register> and connect
   your GitHub.
2. **New → Blueprint**, pick the `coilworks` repository. Render reads
   [`render.yaml`](render.yaml) and configures the service itself.
3. It will prompt for the two secrets marked `sync: false`:
   - `MONGO_URI` — the Atlas string from step 1
   - `ANTHROPIC_API_KEY` — optional; leave empty to run the offline AI analyzer
4. Deploy. The first build takes a few minutes (it builds the client, then the
   image).
5. When it finishes you have a URL like `https://coilworks.onrender.com`. Go to
   **Environment**, set `CORS_ORIGINS` to exactly that origin, and save — the
   service restarts.

   > This step is genuinely required, not ceremony. `validateConfig()` refuses to
   > boot in production with an empty CORS allowlist, so a missing value here
   > shows up as a failed deploy with the reason in the logs.

---

## 3. Seed it

The app starts with an empty database — no machines, no operator to log in as.

Run the seed against Atlas from your machine (it is a one-off, and it is how you
avoid shipping seed data in the image):

```bash
MONGO_URI="<your atlas string>" npm run seed
```

That creates 16 machines across 12 sites, 21 days of sales history, and the two
operator logins. Then build the indexes explicitly — production runs with
`autoIndex` off so a deploy is never blocked by an index build:

```bash
MONGO_URI="<your atlas string>" npm run sync-indexes
```

---

## 4. Bring the fleet to life

A deployed Coilworks with no machines reporting looks broken: every machine reads
offline, because the offline rule is working correctly and nothing is
heartbeating. Point the simulator at the deployed URL:

```bash
MONGO_URI="<your atlas string>" npm run simulate -- --url https://coilworks.onrender.com --scenarios
```

Leave it running while you demo. It re-mints its own machine keys on startup
(keys are stored hashed and are unrecoverable by design), drives telemetry and
sales, and scripts a chiller failure, a coil jam, and a network drop so the
alert pipeline visibly works.

> The simulator runs on **your** machine, not the server. That is deliberate: it
> plays the role of physical hardware, and hardware is not part of the
> deployment.

---

## Verifying the deploy

```bash
curl https://coilworks.onrender.com/api/health
```

```bash
curl https://coilworks.onrender.com/api/ready
```

`/api/health` is liveness — the process is up. `/api/ready` is readiness — it
returns 503 if a change stream has dropped, because at that point the dashboard
would be showing stale data and the instance should come out of rotation.

Full end-to-end check against the deployed instance:

```bash
SMOKE_URL=https://coilworks.onrender.com MONGO_URI="<your atlas string>" npm run smoke
```

---

## Things that will bite you

**The free instance sleeps.** After ~15 minutes idle Render stops it; the next
request takes ~50 seconds to wake it. The WebSocket drops when it sleeps — the
client reconnects with backoff, so the dashboard recovers on its own, but a
visitor's first load is slow. Upgrading the instance or pinging it on a schedule
both fix it.

**Atlas M0 has no dedicated resources.** Fine for a demo; the aggregation
pipelines will feel slower than they do locally.

**Sleeping breaks the offline sweep.** While the instance is asleep nothing runs
the timer that marks silent machines offline, so after a wake you may briefly see
machines that look online but have not reported in an hour. It self-corrects on
the next sweep, 30 seconds later.

**One instance only.** WebSocket fan-out and rate limiting are in-process, so do
not scale this past a single instance without moving both to Redis. See the
Production readiness section of the README.
