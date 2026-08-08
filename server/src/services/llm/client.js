import Anthropic from '@anthropic-ai/sdk';
import { config, hasClaudeKey } from '../../config.js';

let client = null;

/** Lazily constructed so the app boots fine with no API key configured. */
export function anthropic() {
  if (!hasClaudeKey()) return null;
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export const MODEL = config.anthropic.model;

/**
 * Effort is the cost/latency dial on Claude Opus 5. Both AI features here are
 * interactive, so neither runs at the default `high`.
 *
 * Thinking is deliberately left ON (it is the default on Opus 5). Disabling it
 * is the cheaper-looking option but has a specific failure mode with tool use:
 * the model can write a tool call into its visible text instead of emitting a
 * tool_use block, which completes the turn successfully while silently never
 * running the tool. Low effort with thinking on is both safer and cheap.
 */
export const EFFORT = {
  triage: 'low', // one scoped classification per alert
  assistant: 'medium', // multi-step tool use over live fleet data
};

/** What the UI shows in its provider badge. */
export function providerInfo() {
  return hasClaudeKey()
    ? { provider: 'claude', model: MODEL }
    : { provider: 'offline', model: 'rule-based analyzer' };
}
