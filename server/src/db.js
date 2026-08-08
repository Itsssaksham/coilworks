import mongoose from 'mongoose';
import { config } from './config.js';

/**
 * Telemetry is a native MongoDB time-series collection, not an ordinary one.
 * Mongoose can't create those with the shape we want, so it's built here
 * before any model touches it. Time-series buys us columnar storage, automatic
 * bucketing by machine, and TTL expiry without a background job.
 */
async function ensureTelemetryCollection(db) {
  const existing = await db.listCollections({ name: 'telemetry' }).toArray();
  if (existing.length > 0) return;

  await db.createCollection('telemetry', {
    timeseries: {
      timeField: 'ts',
      metaField: 'machineId', // documents for one machine are bucketed together
      granularity: 'minutes',
    },
    expireAfterSeconds: config.telemetryRetentionSeconds,
  });
}

/** Marks the one failure we are certain about, so the catch below can re-throw it. */
class StandaloneError extends Error {}

export async function connect(uri = config.mongoUri) {
  mongoose.set('strictQuery', true);
  // Index builds block startup and can take minutes once a collection is large,
  // so production syncs them deliberately via `npm run sync-indexes` instead of
  // paying for the check on every boot and every deploy.
  mongoose.set('autoIndex', config.autoIndex);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    // Cap how long a single operation can tie up a connection. Without this a
    // pathological query holds one open until the client gives up.
    maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 20),
  });

  const { db } = mongoose.connection;
  await ensureTelemetryCollection(db);

  // Change streams are the backbone of the live dashboard. Catching a standalone
  // mongod here, with a clear message, beats an empty dashboard and a silently
  // dead stream later.
  //
  // The check is best-effort on purpose. Shared-tier hosts (Atlas M0 among them)
  // restrict admin commands, so an authorization failure tells us nothing about
  // the topology - and refusing to boot over it would block a perfectly good
  // managed deployment, which is always a replica set anyway. So: fail loudly
  // when we can prove it is standalone, warn when we cannot tell, never guess.
  try {
    const hello = await db.admin().command({ hello: 1 });
    if (!hello.setName) {
      throw new StandaloneError(
        'Connected to a standalone mongod. Coilworks needs a replica set for change streams ' +
          'and transactions - run `docker compose up -d` or `scripts/mongo-dev.ps1`.',
      );
    }
  } catch (err) {
    if (err instanceof StandaloneError) throw err;
    console.warn(
      `[db] could not verify replica set (${err.message}). ` +
        'This is expected on shared-tier hosts that restrict admin commands. ' +
        'If change streams fail shortly after boot, the server is not a replica set.',
    );
  }

  return mongoose.connection;
}

export async function disconnect() {
  await mongoose.connection.close();
}
