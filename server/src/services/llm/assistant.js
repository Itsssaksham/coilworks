import { anthropic, MODEL, EFFORT } from './client.js';
import { TOOL_DEFS, runTool } from './tools.js';
import { offlineAssistantPlan } from './offline.js';

const SYSTEM = `You are the operations assistant for Coilworks, a vending machine fleet platform.

Answer questions about the fleet by calling the tools. Never answer from memory or
assumption - if you did not read it from a tool result in this conversation, you do
not know it.

Lead with the answer, then the supporting numbers. Reference machines by their code
(VM-0142). Keep responses to a few sentences unless the user asked for a list; when
you do list, give the rows that matter rather than everything you fetched.

When a question implies an action (a restock, a dispatch), say what you would do and
why the data supports it. You cannot perform actions - your tools are read-only.

If the tools return nothing relevant, say so plainly instead of padding the answer.`;

/** Hard stop on the agentic loop so a pathological run can't spin forever. */
const MAX_TURNS = 6;

/**
 * Answer an ops question with tool use over live fleet data.
 *
 * This is a hand-written agentic loop rather than the SDK's tool runner: the
 * runner is a beta surface, and the loop here is small enough that owning it
 * keeps the offline path symmetrical and the trace easy to return to the UI.
 *
 * @returns {{answer: string, trace: Array, provider: string, model: string}}
 *   `trace` is every tool call and result, which the UI shows so an operator can
 *   check the answer against the queries that produced it.
 */
export async function askAssistant(question) {
  const client = anthropic();
  return client ? askClaude(client, question) : askOffline(question);
}

async function askClaude(client, question) {
  const messages = [{ role: 'user', content: question }];
  const trace = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOL_DEFS,
      output_config: { effort: EFFORT.assistant },
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return {
        answer: 'The model declined to answer that request.',
        trace,
        provider: 'claude',
        model: MODEL,
      };
    }

    // Echo the assistant turn back verbatim - dropping thinking or tool_use
    // blocks here breaks the next request.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');

    if (toolUses.length === 0) {
      const answer = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { answer, trace, provider: 'claude', model: MODEL };
    }

    // Run requested tools concurrently, then return every result in ONE user
    // message. Splitting them across messages teaches the model to stop
    // parallelising.
    const results = await Promise.all(
      toolUses.map(async (call) => {
        try {
          const result = await runTool(call.name, call.input);
          trace.push({ tool: call.name, input: call.input, ok: true, result });
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          trace.push({ tool: call.name, input: call.input, ok: false, error: err.message });
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Tool failed: ${err.message}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: 'user', content: results });
  }

  return {
    answer:
      'I ran out of steps before reaching an answer. Try narrowing the question to one machine or one time window.',
    trace,
    provider: 'claude',
    model: MODEL,
  };
}

/**
 * Offline path: keyword-route to one tool and render its result.
 *
 * It is not a language model and does not pretend to be - the UI labels it as
 * the offline analyzer. The value is that the panel still returns real,
 * database-grounded data with no API key configured.
 */
async function askOffline(question) {
  const plan = offlineAssistantPlan(question);
  const result = await runTool(plan.tool, plan.input);
  const trace = [{ tool: plan.tool, input: plan.input, ok: true, result }];

  return {
    answer: renderOffline(plan.tool, result),
    trace,
    provider: 'offline',
    model: 'rule-based analyzer',
  };
}

function renderOffline(tool, result) {
  const money = (c) => `$${(c / 100).toFixed(2)}`;

  switch (tool) {
    case 'fleet_summary':
      return [
        `${result.machines.online}/${result.machines.total} machines online (${result.machines.offline} offline, ${result.machines.fault} faulted).`,
        `Inventory is ${Math.round(result.inventory.fillRatio * 100)}% full with ${result.inventory.emptySlots} empty slots.`,
        `Last 24h: ${result.last24h.units} vends, ${money(result.last24h.revenueCents)}.`,
        `Cash on hand across the fleet: ${money(result.cashOnHandCents)}.`,
      ].join(' ');

    case 'forecast_stockouts': {
      if (result.length === 0) return 'No slots are projected to empty inside the forecast horizon.';
      const soonest = result.slice(0, 5);
      return [
        `${result.length} slot(s) will empty within the horizon. Soonest:`,
        ...soonest.map(
          (r) =>
            `  ${r.machine} slot ${r.slot} (${r.sku}) - ${r.qty} left, ${r.ratePerDay}/day, ~${r.daysToEmpty ?? 0} days.`,
        ),
      ].join('\n');
    }

    case 'find_machines':
      if (result.length === 0) return 'No machines matched that filter.';
      return [
        `${result.length} machine(s):`,
        ...result.slice(0, 10).map((m) => `  ${m.code} - ${m.site} - ${m.status}`),
      ].join('\n');

    case 'list_alerts':
      if (result.length === 0) return 'No alerts match that filter.';
      return [
        `${result.length} alert(s):`,
        ...result.slice(0, 10).map((a) => `  [${a.severity}] ${a.machine} - ${a.message}`),
      ].join('\n');

    case 'sales_summary':
      if (result.length === 0) return 'No sales in that window.';
      return [
        'Top sellers:',
        ...result.map((p) => `  ${p.name} - ${p.units} units, ${money(p.revenueCents)}`),
      ].join('\n');

    default:
      return JSON.stringify(result, null, 2);
  }
}
