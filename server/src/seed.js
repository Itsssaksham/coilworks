import mongoose from 'mongoose';
import { connect, disconnect } from './db.js';
import { Machine } from './models/Machine.js';
import { Product } from './models/Product.js';
import { Sale } from './models/Sale.js';
import { Alert } from './models/Alert.js';
import { Operator } from './models/Operator.js';
import { RestockRun } from './models/RestockRun.js';
import { generateMachineKey } from './middleware/auth.js';

/**
 * Seeds a fleet across Chandigarh / Mohali / Panchkula, then back-fills 21 days
 * of sales history.
 *
 * The history is what makes the app real on first load: the depletion forecast
 * measures a rate from actual sales, so without history every slot reports an
 * unknown rate and the restock planner has nothing to plan from.
 *
 * Deterministic: a seeded PRNG means every run produces the same fleet, so the
 * smoke test can assert on it and a demo looks the same on any machine.
 */

// mulberry32 - small, fast, and reproducible from a fixed seed.
function rng(seed = 0x5eed) {
  return function next() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = [
  { sku: 'COLA-330', name: 'Cola 330ml', category: 'soda', costCents: 1800, listPriceCents: 4000, requiresChilled: true },
  { sku: 'LEMN-330', name: 'Lemon Soda 330ml', category: 'soda', costCents: 1700, listPriceCents: 4000, requiresChilled: true },
  { sku: 'WATR-500', name: 'Mineral Water 500ml', category: 'water', costCents: 700, listPriceCents: 2000, requiresChilled: true },
  { sku: 'ENRG-250', name: 'Energy Drink 250ml', category: 'energy', costCents: 4500, listPriceCents: 9000, requiresChilled: true },
  { sku: 'COFF-200', name: 'Cold Coffee 200ml', category: 'coffee', costCents: 3000, listPriceCents: 6000, requiresChilled: true },
  { sku: 'CHIP-052', name: 'Potato Chips 52g', category: 'snack', costCents: 1000, listPriceCents: 2000, requiresChilled: false },
  { sku: 'NACH-060', name: 'Nachos 60g', category: 'snack', costCents: 1500, listPriceCents: 3000, requiresChilled: false },
  { sku: 'CHOC-040', name: 'Chocolate Bar 40g', category: 'candy', costCents: 1600, listPriceCents: 3500, requiresChilled: false },
  { sku: 'BISC-075', name: 'Biscuits 75g', category: 'snack', costCents: 900, listPriceCents: 2000, requiresChilled: false },
  { sku: 'TRAIL-45', name: 'Trail Mix 45g', category: 'snack', costCents: 2200, listPriceCents: 4500, requiresChilled: false },
];

const SITES = [
  { site: 'Elante Mall',            address: 'Industrial Area Phase I, Chandigarh',   lng: 76.8014, lat: 30.7052 },
  { site: 'ISBT Sector 43',         address: 'Sector 43, Chandigarh',                 lng: 76.7595, lat: 30.7185 },
  { site: 'PGIMER Block A',         address: 'Sector 12, Chandigarh',                 lng: 76.7679, lat: 30.7644 },
  { site: 'Panjab University Hub',  address: 'Sector 14, Chandigarh',                 lng: 76.7625, lat: 30.7590 },
  { site: 'IT Park Tower B',        address: 'Rajiv Gandhi IT Park, Chandigarh',      lng: 76.8420, lat: 30.7280 },
  { site: 'Sector 17 Plaza',        address: 'Sector 17, Chandigarh',                 lng: 76.7794, lat: 30.7410 },
  { site: 'Mohali Cricket Stadium', address: 'Sector 63, Mohali',                     lng: 76.7370, lat: 30.6910 },
  { site: 'Quark City Mohali',      address: 'A-45 Industrial Area, Mohali',          lng: 76.7248, lat: 30.7060 },
  { site: 'Panchkula Bus Stand',    address: 'Sector 5, Panchkula',                   lng: 76.8530, lat: 30.6942 },
  { site: 'Chandigarh Airport',     address: 'Sector 65, Mohali',                     lng: 76.7885, lat: 30.6735 },
  { site: 'Sukhna Lake Gate',       address: 'Sector 1, Chandigarh',                  lng: 76.8106, lat: 30.7425 },
  { site: 'Rock Garden Entrance',   address: 'Sector 1, Chandigarh',                  lng: 76.8050, lat: 30.7525 },
];

const MODELS = ['Coilworks C7 Chiller', 'Coilworks C7 Ambient', 'Coilworks S4 Compact'];
const SLOT_ROWS = ['A', 'B', 'C', 'D'];

function buildPlanogram(random, chilled) {
  const pool = chilled ? PRODUCTS : PRODUCTS.filter((p) => !p.requiresChilled);
  const slots = [];
  for (const row of SLOT_ROWS) {
    for (let col = 1; col <= 5; col++) {
      const product = pool[Math.floor(random() * pool.length)];
      const capacity = 8 + Math.floor(random() * 8); // 8-15
      slots.push({
        code: `${row}${col}`,
        sku: product.sku,
        capacity,
        qty: Math.max(0, Math.round(capacity * (0.35 + random() * 0.6))),
        parLevel: Math.max(2, Math.round(capacity * 0.25)),
        priceCents: product.listPriceCents,
      });
    }
  }
  return slots;
}

async function seed() {
  const random = rng();
  await connect();

  console.log('[seed] clearing existing data...');
  await Promise.all([
    Machine.deleteMany({}),
    Product.deleteMany({}),
    Sale.deleteMany({}),
    Alert.deleteMany({}),
    Operator.deleteMany({}),
    RestockRun.deleteMany({}),
  ]);
  // Time-series documents cannot be deleted individually, so the collection is
  // dropped and recreated by connect() on the next boot.
  await mongoose.connection.db.collection('telemetry').drop().catch(() => {});

  console.log('[seed] products...');
  await Product.insertMany(PRODUCTS);

  console.log('[seed] operators...');
  const password = await Operator.hashPassword('coilworks');
  await Operator.insertMany([
    { email: 'ops@coilworks.io', name: 'Fleet Admin', passwordHash: password, role: 'admin' },
    { email: 'dispatch@coilworks.io', name: 'Dispatch Desk', passwordHash: password, role: 'dispatcher' },
  ]);

  console.log('[seed] machines...');
  const machineKeys = [];
  const machines = [];

  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    // Two machines at the larger sites, one elsewhere.
    const count = i < 4 ? 2 : 1;

    for (let n = 0; n < count; n++) {
      const model = MODELS[Math.floor(random() * MODELS.length)];
      const chilled = !model.includes('Ambient');
      const key = generateMachineKey();
      const code = `VM-${String(1000 + machines.length + 1).padStart(4, '0')}`;

      machineKeys.push({ code, key: key.plain });
      machines.push({
        code,
        name: `${site.site} ${n === 0 ? 'Main' : 'Annex'}`,
        model,
        firmware: `2.${4 + Math.floor(random() * 3)}.${Math.floor(random() * 9)}`,
        siteName: site.site,
        address: site.address,
        // Jitter so two machines at one site are not stacked on the map.
        location: {
          type: 'Point',
          coordinates: [site.lng + (random() - 0.5) * 0.004, site.lat + (random() - 0.5) * 0.004],
        },
        status: 'online',
        lastSeenAt: new Date(),
        temperatureC: chilled ? 3 + random() * 3 : 22 + random() * 4,
        cashCents: Math.floor(random() * 30000),
        cashCapacityCents: 40000,
        signalStrength: 45 + Math.floor(random() * 55),
        slots: buildPlanogram(random, chilled),
        apiKeyHash: key.hash,
        apiKeyLast4: key.last4,
      });
    }
  }

  const created = await Machine.insertMany(machines);
  console.log(`[seed] ${created.length} machines across ${SITES.length} sites`);

  console.log('[seed] back-filling 21 days of sales...');
  const sales = [];
  const now = Date.now();
  const DAYS = 21;

  for (const machine of created) {
    // Each machine gets its own footfall multiplier, so sites differ in volume
    // and the forecast has something to distinguish.
    const footfall = 0.4 + random() * 1.8;

    for (let day = DAYS; day >= 0; day--) {
      for (let hour = 7; hour <= 21; hour++) {
        // Lunch and evening peaks - a flat rate would make every forecast identical.
        const peak = hour >= 12 && hour <= 14 ? 2.2 : hour >= 17 && hour <= 19 ? 1.8 : 1;
        const expected = footfall * peak;
        const count = Math.floor(expected + (random() < expected % 1 ? 1 : 0));

        for (let s = 0; s < count; s++) {
          const slot = machine.slots[Math.floor(random() * machine.slots.length)];
          const ts = new Date(now - day * 86_400_000 + (hour - 24) * 3_600_000 + random() * 3_600_000);
          if (ts.getTime() > now) continue;
          sales.push({
            machineId: machine._id,
            machineCode: machine.code,
            slotCode: slot.code,
            sku: slot.sku,
            priceCents: slot.priceCents,
            payment: random() < 0.62 ? 'card' : random() < 0.7 ? 'mobile' : 'cash',
            ts,
          });
        }
      }
    }
  }

  // insertMany in chunks - one 40k-document call risks the 16MB BSON cap.
  for (let i = 0; i < sales.length; i += 5000) {
    await Sale.insertMany(sales.slice(i, i + 5000), { ordered: false });
  }
  console.log(`[seed] ${sales.length} historical sales`);

  console.log('\n=== Machine ingest keys (shown once) ===');
  for (const { code, key } of machineKeys.slice(0, 3)) {
    console.log(`  ${code}  ${key}`);
  }
  console.log(`  ... and ${machineKeys.length - 3} more (the simulator re-mints its own).`);

  console.log('\n=== Operator login ===');
  console.log('  ops@coilworks.io / coilworks       (admin)');
  console.log('  dispatch@coilworks.io / coilworks  (dispatcher)');

  await disconnect();
  console.log('\n[seed] done.');
}

seed().catch(async (err) => {
  console.error('[seed] failed:', err);
  await disconnect().catch(() => {});
  process.exit(1);
});
