/**
 * Fail-closed context/cost budgets (t1765u Cap 2) — vendored for OMB.
 * Pin: see VERSION.
 */

function finiteNonNeg(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export type BudgetUsage = {
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  steps?: number;
};

export type BudgetPolicy = {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxUsd?: number;
  maxSteps?: number;
};

export type BudgetResult =
  | { allow: true; remaining: Record<string, number> }
  | { allow: false; reason: string };

/**
 * Evaluate usage against a budget policy. Missing/empty policy → deny (fail closed).
 */
export function evaluateBudget(
  usage: BudgetUsage | null | undefined,
  policy: BudgetPolicy | null | undefined,
): BudgetResult {
  if (!policy || typeof policy !== "object") {
    return { allow: false, reason: "budget_undefined" };
  }

  const keys = ["maxInputTokens", "maxOutputTokens", "maxUsd", "maxSteps"] as const;
  const configured = keys.filter((k) => policy[k] !== undefined && policy[k] !== null);
  if (configured.length === 0) {
    return { allow: false, reason: "budget_undefined" };
  }

  const u = usage && typeof usage === "object" ? usage : {};
  const map: [keyof BudgetPolicy, keyof BudgetUsage][] = [
    ["maxInputTokens", "inputTokens"],
    ["maxOutputTokens", "outputTokens"],
    ["maxUsd", "usd"],
    ["maxSteps", "steps"],
  ];

  for (const [pKey, uKey] of map) {
    if (policy[pKey] === undefined || policy[pKey] === null) continue;
    if (!finiteNonNeg(policy[pKey])) {
      return { allow: false, reason: "budget_undefined" };
    }
    const used = u[uKey];
    if (used === undefined) continue;
    if (!finiteNonNeg(used)) {
      return { allow: false, reason: "usage_invalid" };
    }
    if (used > (policy[pKey] as number)) {
      return { allow: false, reason: `budget_exceeded:${pKey}` };
    }
  }

  const remaining: Record<string, number> = {};
  for (const [pKey, uKey] of map) {
    if (policy[pKey] === undefined || policy[pKey] === null) continue;
    const used = finiteNonNeg(u[uKey]) ? (u[uKey] as number) : 0;
    remaining[uKey] = (policy[pKey] as number) - used;
  }
  return { allow: true, remaining };
}
