import { Telemetry } from '../../models/Telemetry.js';
import { Alert } from '../../models/Alert.js';
import { anthropic, MODEL, EFFORT } from './client.js';
import { offlineTriage } from './offline.js';

/**
 * Shape every triage result must satisfy, whether it came from Claude or the
 * offline analyzer. Passed to the API as a JSON schema so the model's output is
 * constrained rather than parsed hopefully.
 */
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', description: 'What is wrong, in one or two sentences.' },
    likelyCause: { type: 'string', description: 'The most probable root cause.' },
    recommendedAction: { type: 'string', description: 'The single next action for the operator.' },
    dispatchRequired: {
      type: 'boolean',
      description: 'True only if a technician must physically visit the machine.',
    },
    confidence: { type: 'number', description: 'Confidence 0-1 in this diagnosis.' },
  },
  required: ['diagnosis', 'likelyCause', 'recommendedAction', 'dispatchRequired', 'confidence'],
  additionalProperties: false,
};

const SYSTEM = `You triage faults on a vending machine fleet for the operations team.

You receive one alert plus the machine's recent telemetry. Diagnose the fault and
give the operator their next action.

Ground every claim in the telemetry you were given. If the readings do not
support a specific cause, say the cause is undetermined and recommend the check
that would narrow it down - do not invent a cause to sound decisive.

Reserve dispatchRequired for faults that genuinely need someone on site
(a jam, a failed compressor, a dead controller). Restocking, cash collection,
and anything resolvable remotely are not dispatches.`;

/** Recent readings for one machine, oldest first, as compact context. */
async function recentTelemetry(machineId, limit = 40) {
  const rows = await Telemetry.find({ machineId }).sort({ ts: -1 }).limit(limit).lean();
  return rows.reverse().map((r) => ({
    ts: r.ts,
    tempC: r.temperatureC,
    door: r.doorOpen,
    power: r.powerOk,
    signal: r.signalStrength,
    faults: r.coilFaults,
  }));
}

/**
 * Diagnose one alert. Results are cached onto the alert document, so reopening
 * it in the UI does not pay for another model call.
 *
 * @param {object} alert   an Alert document
 * @param {object} machine the Machine it belongs to
 * @param {boolean} force  recompute even if a cached triage exists
 */
export async function triageAlert({ alert, machine, force = false }) {
  if (!force && alert.triage?.generatedAt) return alert.triage;

  const telemetry = await recentTelemetry(alert.machineId);
  const context = {
    alert: {
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      detail: alert.detail,
      openedAt: alert.openedAt,
    },
    machine: {
      code: machine.code,
      model: machine.model,
      firmware: machine.firmware,
      site: machine.siteName,
      status: machine.status,
      lastSeenAt: machine.lastSeenAt,
      slots: machine.slots.map((s) => ({
        code: s.code, sku: s.sku, qty: s.qty, capacity: s.capacity, jammed: s.jammed,
      })),
    },
    telemetry,
  };

  const client = anthropic();
  const result = client
    ? await triageWithClaude(client, context)
    : offlineTriage(context);

  const triage = { ...result, generatedAt: new Date() };
  await Alert.updateOne({ _id: alert._id }, { $set: { triage } });
  return triage;
}

async function triageWithClaude(client, context) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: {
      effort: EFFORT.triage,
      format: { type: 'json_schema', schema: TRIAGE_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Triage this alert.\n\n${JSON.stringify(context, null, 2)}`,
      },
    ],
  });

  // Safety classifiers can decline a request; that returns HTTP 200 with a
  // refusal stop reason and no usable content, so check before reading it.
  if (response.stop_reason === 'refusal') {
    return {
      ...offlineTriage(context),
      provider: 'offline',
      model: 'rule-based analyzer (model declined)',
    };
  }

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{}';
  const parsed = JSON.parse(text);

  return { ...parsed, provider: 'claude', model: MODEL };
}
