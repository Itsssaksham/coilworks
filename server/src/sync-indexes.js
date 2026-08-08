/**
 * Build every index declared on the models, then exit.
 *
 * Production runs with autoIndex disabled, because Mongoose otherwise checks
 * and builds indexes on every boot - which blocks startup and, on a large
 * collection, can stall a deploy for minutes. This makes that step explicit:
 * run it once as part of a release, before or alongside rolling the new version.
 *
 * Usage:  npm run sync-indexes
 */
import mongoose from 'mongoose';
import { connect, disconnect } from './db.js';
import { log } from './logger.js';

// Importing the models is what registers their schemas and index definitions.
import './models/Machine.js';
import './models/Product.js';
import './models/Sale.js';
import './models/Alert.js';
import './models/Operator.js';
import './models/RestockRun.js';

async function main() {
  await connect();

  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    const started = Date.now();
    await model.syncIndexes();
    const indexes = await model.listIndexes();
    log.info('indexes synced', {
      model: name,
      count: indexes.length,
      ms: Date.now() - started,
    });
  }

  await disconnect();
  log.info('index sync complete');
}

main().catch(async (err) => {
  log.error('index sync failed', { error: err.message });
  await disconnect().catch(() => {});
  process.exit(1);
});
