/**
 * Smallest OMB P1 adapter gate (t1765u): sanitize + fail-closed budget
 * before a room handoff text is accepted at enqueue.
 *
 * Wired from server/room-handoffs.ts enqueue. No Temporal, Slack, Langfuse,
 * MCP server, protect SoT, or tool-allowlist changes. Offline / pure.
 */

import { evaluateBudget, type BudgetPolicy, type BudgetUsage } from "./budgets.ts";
import { sanitizeHandoff } from "./sanitize.ts";

export type HandoffGateOk = {
  ok: true;
  sanitizedText: string;
  stripped: string[];
  remaining?: Record<string, number>;
};

export type HandoffGateFail = {
  ok: false;
  reason: string;
  message: string;
  stripped: string[];
};

/**
 * Gate a room-handoff emission payload.
 * - Undefined/empty budget policy → deny (Cap2 fail-closed).
 * - Unsanitizable / secret-bearing structures → deny after sanitize attempt.
 * - On success, returns sanitized text suitable for persistence.
 */
export function gateHandoffEmission(input: {
  text: string;
  usage: BudgetUsage;
  policy: BudgetPolicy | null | undefined;
}): HandoffGateOk | HandoffGateFail {
  const budget = evaluateBudget(input.usage, input.policy);
  if (!budget.allow) {
    return {
      ok: false,
      reason: budget.reason,
      message: `Room handoff budget gate refused: ${budget.reason}`,
      stripped: [],
    };
  }

  const sanitized = sanitizeHandoff({ text: input.text });
  if (!sanitized.ok) {
    return {
      ok: false,
      reason: sanitized.reason,
      message: `Room handoff sanitization refused: ${sanitized.reason}`,
      stripped: sanitized.stripped,
    };
  }

  const payload = sanitized.sanitized as { text?: unknown };
  if (typeof payload.text !== "string") {
    return {
      ok: false,
      reason: "unsanitizable",
      message: "Room handoff sanitization refused: text missing after sanitize",
      stripped: sanitized.stripped,
    };
  }

  return {
    ok: true,
    sanitizedText: payload.text,
    stripped: sanitized.stripped,
    remaining: budget.remaining,
  };
}

/** Build Cap2 policy from room handoff execution ceiling (fail-closed if missing). */
export function policyFromRoomLimits(limits: { executions?: number } | null | undefined): BudgetPolicy | null {
  if (!limits || typeof limits.executions !== "number" || !Number.isFinite(limits.executions) || limits.executions < 0) {
    return null;
  }
  return { maxSteps: limits.executions };
}
