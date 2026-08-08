/**
 * Deterministic, offline stand-in for the Claude-backed AI features.
 *
 * This is NOT a language model. It is a rule table that satisfies the same
 * contracts, so the whole product - triage, the ops assistant, the UI badges -
 * works with no API key and no spend. Being deterministic also makes the smoke
 * test able to assert on exact output.
 *
 * Everything it returns is labelled provider: "offline" and the UI says so, so
 * it can never be mistaken for real model output.
 */

const CHILLED_MAX_C = 7;

/** @returns {{diagnosis,likelyCause,recommendedAction,dispatchRequired,confidence,provider,model}} */
export function offlineTriage(context) {
  const { alert, machine, telemetry } = context;
  const latest = telemetry.at(-1) ?? {};
  const base = { provider: 'offline', model: 'rule-based analyzer' };

  switch (alert.type) {
    case 'temperature': {
      const temps = telemetry.map((t) => t.tempC).filter((n) => n != null);
      const rising = temps.length >= 2 && temps.at(-1) > temps[0];
      const doorEvents = telemetry.filter((t) => t.door).length;
      return {
        ...base,
        diagnosis: `Cabinet is at ${latest.tempC?.toFixed?.(1) ?? '?'}C against a ${CHILLED_MAX_C}C ceiling, ${
          rising ? 'and still climbing' : 'and has stopped climbing'
        }.`,
        likelyCause:
          doorEvents > 3
            ? `Door registered open on ${doorEvents} of the last ${telemetry.length} readings - the cabinet is being held open.`
            : rising
              ? 'Compressor is not holding temperature; likely a refrigeration fault rather than door usage.'
              : 'Transient warm-up, temperature has levelled off.',
        recommendedAction: rising
          ? 'Dispatch a technician to check the compressor and condenser. Move chilled stock if it stays above range for another hour.'
          : 'Monitor for 30 minutes. If it does not return below 7C, dispatch a refrigeration check.',
        dispatchRequired: rising && doorEvents <= 3,
        confidence: rising ? 0.72 : 0.55,
      };
    }

    case 'jam': {
      const slot = alert.detail?.slotCode;
      return {
        ...base,
        diagnosis: `Spiral ${slot} reported a turn with no vend detected.`,
        likelyCause:
          'Product bridged across the spiral or is mis-loaded - the most common cause of a turn-without-vend.',
        recommendedAction: `Block slot ${slot} in the planogram and clear it on the next scheduled visit. Re-face the product when reloading.`,
        dispatchRequired: true,
        confidence: 0.68,
      };
    }

    case 'offline': {
      const weakSignal = latest.signal != null && latest.signal < 25;
      return {
        ...base,
        diagnosis: `No heartbeat from ${machine.code} since ${machine.lastSeenAt ?? 'unknown'}.`,
        likelyCause: weakSignal
          ? `Last reading showed signal at ${latest.signal}/100 - likely a connectivity drop rather than a dead machine.`
          : latest.power === false
            ? 'Last reading showed mains power lost; the machine most likely powered down.'
            : 'Undetermined from telemetry - the machine stopped reporting while healthy.',
        recommendedAction: weakSignal
          ? 'Wait one more heartbeat window before dispatching; check the site modem if it stays dark.'
          : 'Check site power, then dispatch if the machine does not return within the hour.',
        dispatchRequired: !weakSignal && latest.power !== false,
        confidence: weakSignal || latest.power === false ? 0.7 : 0.4,
      };
    }

    case 'stockout':
    case 'low_stock': {
      const slot = machine.slots?.find((s) => s.code === alert.detail?.slotCode);
      return {
        ...base,
        diagnosis: `Slot ${alert.detail?.slotCode} is at ${slot?.qty ?? 0}/${slot?.capacity ?? '?'} units.`,
        likelyCause: 'Normal depletion - sales outpaced the restock interval for this selection.',
        recommendedAction: `Add ${alert.detail?.slotCode} to the next restock run. If this slot empties repeatedly, raise its par level.`,
        dispatchRequired: false,
        confidence: 0.9,
      };
    }

    case 'cash_full':
      return {
        ...base,
        diagnosis: 'Cash box is near capacity and will start refusing coins.',
        likelyCause: 'Collection interval is too long for this machine\'s cash volume.',
        recommendedAction: 'Schedule a collection on the next run and shorten the interval for this site.',
        dispatchRequired: false,
        confidence: 0.95,
      };

    case 'power':
      return {
        ...base,
        diagnosis: 'Machine reports mains power lost and is running on backup.',
        likelyCause: 'Site-level outage or a tripped circuit - the machine itself is reporting normally.',
        recommendedAction: 'Contact the site before dispatching; confirm whether other equipment lost power.',
        dispatchRequired: false,
        confidence: 0.6,
      };

    default:
      return {
        ...base,
        diagnosis: alert.message,
        likelyCause: 'Undetermined from the available telemetry.',
        recommendedAction: 'Review the machine detail page and recent readings.',
        dispatchRequired: false,
        confidence: 0.3,
      };
  }
}

/**
 * Offline stand-in for the ops assistant. It does not parse natural language -
 * it keyword-routes to the same read-only tools Claude would call, so the panel
 * returns real data grounded in the database instead of a canned string.
 */
export function offlineAssistantPlan(question) {
  const q = question.toLowerCase();
  if (/(stock ?out|run out|empty|refill|restock|low)/.test(q)) {
    return { tool: 'forecast_stockouts', input: { horizonDays: 7 } };
  }
  if (/(offline|down|dead|not report|fault|broken)/.test(q)) {
    return { tool: 'find_machines', input: { status: 'offline', limit: 20 } };
  }
  if (/(alert|issue|problem|wrong)/.test(q)) {
    return { tool: 'list_alerts', input: { status: 'open', limit: 20 } };
  }
  if (/(sell|sold|revenue|best|top|popular|sales)/.test(q)) {
    return { tool: 'sales_summary', input: { days: 7 } };
  }
  return { tool: 'fleet_summary', input: {} };
}
