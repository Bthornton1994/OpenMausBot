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

  // Fixtures are assembled at runtime so no token-shaped literal sits in the
  // source; GitHub push protection flags those (as in server/redact.test.ts).
  const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
  it.each([
    ["an Anthropic key", "sk_ant", `sk-ant-api03-${alpha}`],
    ["an OpenAI project key", "sk_proj", `sk-proj-${alpha}`],
    ["a generic sk- key", "sk_like", `sk-${alpha}`],
    ["a GitHub fine-grained PAT", "github_pat", `${"github_" + "pat_"}11ABCDEFG0${alpha}`],
    ["a GitHub classic PAT (ghp_)", "gh_fine", `${"gh" + "p_"}${alpha}`],
    ["a GitHub OAuth token (gho_)", "gh_fine", `${"gh" + "o_"}${alpha}`],
    ["a GitHub server token (ghs_)", "gh_fine", `${"gh" + "s_"}${alpha}`],
    ["a GitHub user token (ghu_)", "gh_fine", `${"gh" + "u_"}${alpha}`],
    ["a Slack bot token", "xox", `${"xox" + "b-"}123456789012-${alpha.slice(0, 24)}`],
    ["an AWS access key ID", "akia", "AKIA" + "IOSFODNN7EXAMPLE"],
    ["an xAI key", "xai", `xai-${alpha}`],
    ["a Bearer token", "bearer", `Bearer ${alpha}`],
  ] as const)("redacts %s in brief text and flags it when raw", (_label, pattern, secret) => {
    const brief = `Call the API with ${secret} and report back`;
    expect(assertNoRawSecrets(brief)).toMatchObject({ ok: false, pattern });
    const r = sanitizeHandoff({ text: brief });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = (r.sanitized as { text: string }).text;
    expect(text).toBe(`Call the API with «redacted ${secret.length} chars» and report back`);
    expect(r.stripped).toEqual([`content:${pattern}`]);
    expect(assertNoRawSecrets(text).ok).toBe(true);
  });

  it("redacts a PEM private key block", () => {
    const pem = ["-----BEGIN " + "PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "-----END " + "PRIVATE KEY-----"].join("\n");
    const r = sanitizeHandoff({ text: `Install this key:\n${pem}\nthen restart` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.sanitized as { text: string }).text).toBe(`Install this key:\n«redacted ${pem.length} chars»\nthen restart`);
    expect(r.stripped).toEqual(["content:pem"]);
  });

  it("leaves ordinary prose alone, including the word bearer", () => {
    const prose = [
      "Tell the bearer of this note to wait for the review.",
      "Bearer of good news: the risk-assessment task-list is done.",
      "Use a Bearer token from the vault; never paste it here.",
    ].join("\n");
    expect(sanitizeHandoff({ text: prose })).toEqual({ ok: true, sanitized: { text: prose }, stripped: [] });
    expect(assertNoRawSecrets(prose).ok).toBe(true);
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

  it("refuses once the root has used every execution, allows while one remains", () => {
    const policy = policyFromRoomLimits({ executions: 48 });
    // Enqueue counts the execution the new work needs: steps = root.executions + 1.
    const spent = gateHandoffEmission({ text: "build it", usage: { steps: 48 + 1 }, policy });
    expect(spent.ok).toBe(false);
    if (!spent.ok) expect(spent.reason).toBe("budget_exceeded:maxSteps");
    const lastOne = gateHandoffEmission({ text: "build it", usage: { steps: 47 + 1 }, policy });
    expect(lastOne.ok).toBe(true);
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
