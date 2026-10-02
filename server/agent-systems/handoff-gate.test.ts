import { describe, expect, it } from "vitest";
import { evaluateBudget } from "./budgets.ts";
import { gateHandoffEmission, policyFromRoomLimits } from "./handoff-gate.ts";
import { assertNoRawSecrets, sanitizeHandoff } from "./sanitize.ts";

describe("agent-systems Cap1 sanitize (OMB vendor)", () => {
  it("masks secret keys and content patterns", () => {
    const r = sanitizeHandoff({
      task: "ok",
      apiKey: "sk-abcdefghijklmnopqrstuvwx",
      note: "Authorization: Bearer abcdefghijklmnop",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = JSON.stringify(r.sanitized);
    expect(assertNoRawSecrets(s).ok).toBe(true);
    expect(r.stripped.length).toBeGreaterThanOrEqual(2);
    expect(s.includes("sk-abcdefghijklmnop")).toBe(false);
  });

  it("fails closed on circular input", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    const r = sanitizeHandoff(o);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unsanitizable");
  });
});

describe("agent-systems Cap2 budgets (OMB vendor)", () => {
  it("denies empty or null policy", () => {
    expect(evaluateBudget({ steps: 1 }, {}).allow).toBe(false);
    const denied = evaluateBudget({ steps: 1 }, null);
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.reason).toBe("budget_undefined");
  });

  it("denies exceeded maxSteps and allows under ceiling", () => {
    const over = evaluateBudget({ steps: 3 }, { maxSteps: 2 });
    expect(over.allow).toBe(false);
    if (!over.allow) expect(over.reason).toBe("budget_exceeded:maxSteps");
    const ok = evaluateBudget({ steps: 1 }, { maxSteps: 5 });
    expect(ok.allow).toBe(true);
    if (ok.allow) expect(ok.remaining.steps).toBe(4);
  });
});

describe("handoff-gate at room enqueue", () => {
  it("refuses when policy is undefined (fail-closed)", () => {
    const r = gateHandoffEmission({ text: "build it", usage: { steps: 0 }, policy: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("budget_undefined");
    expect(r.message).toMatch(/budget gate refused/);
  });

  it("refuses when execution budget already exceeded", () => {
    const policy = policyFromRoomLimits({ executions: 48 });
    const r = gateHandoffEmission({ text: "build it", usage: { steps: 49 }, policy });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("budget_exceeded:maxSteps");
  });

  it("sanitizes secret-shaped text and allows under budget", () => {
    const policy = policyFromRoomLimits({ executions: 48 });
    const raw = "Use Bearer abcdefghijklmnop for the call";
    const r = gateHandoffEmission({ text: raw, usage: { steps: 2 }, policy });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sanitizedText.includes("abcdefghijklmnop")).toBe(false);
    expect(r.sanitizedText).toMatch(/«redacted/);
    expect(assertNoRawSecrets(r.sanitizedText).ok).toBe(true);
  });

  it("policyFromRoomLimits fails closed on missing executions", () => {
    expect(policyFromRoomLimits(null)).toBeNull();
    expect(policyFromRoomLimits({})).toBeNull();
    expect(policyFromRoomLimits({ executions: Number.NaN })).toBeNull();
    expect(policyFromRoomLimits({ executions: 48 })).toEqual({ maxSteps: 48 });
  });
});
