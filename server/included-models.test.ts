import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import {
  includedModelPolicy, INCLUDED_AGENT_ID, INCLUDED_ALLOWANCE_MESSAGE, INCLUDED_CODEX_ID, isAllowanceRefusal, isIncludedInstanceId,
} from "./included-models.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { recordEvents } from "./testing/events.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [], registries: ProviderRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.disposeAll()));
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await removeTempDir(directory);
});
const directory = () => { const value = mkdtempSync(join(tmpdir(), "omb-included-")); directories.push(value); return value; };
const token = `omb_cloudai_${"t".repeat(43)}`;
const gateway = (models: { openai?: string[]; openrouter?: string[] } = {}) => ({
  base: "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd", token,
  openai: models.openai ?? ["gpt-fixture"], openrouter: models.openrouter ?? ["anthropic/claude-fixture", "openai/gpt-fixture"],
});

it("adds included instances under their own ids, routed to this machine's gateway", () => {
  const root = directory(), policy = includedModelPolicy(gateway(), root);
  const configs = policy.configs();
  expect(Object.keys(configs)).toEqual([INCLUDED_AGENT_ID, INCLUDED_CODEX_ID]);
  expect(Object.keys(configs).every(isIncludedInstanceId)).toBe(true);
  expect(configs[INCLUDED_AGENT_ID]).toMatchObject({ driver: "openai-compat", config: {
    url: "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd/openrouter/v1", apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY",
    managedModels: ["anthropic/claude-fixture", "openai/gpt-fixture"] }, environment: { OPENMAUSBOT_COMPANY_API_KEY: token } });
  expect(configs[INCLUDED_CODEX_ID]).toMatchObject({ driver: "codex", config: { managed: { url: "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd/openai/v1", models: ["gpt-fixture"] } },
    environment: { OPENMAUSBOT_COMPANY_API_KEY: token, CODEX_HOME: join(root, "providers/included/codex") } });
  // The key reaches only the gateway-bound instances, never Claude Code.
  expect(Object.values(configs).some(entry => entry.driver === "claudeAgent")).toBe(false);
  expect(JSON.stringify(Object.values(configs).map(entry => entry.config))).not.toContain(token);
  expect(Object.keys(includedModelPolicy(gateway({ openai: [] }), root).configs())).toEqual([INCLUDED_AGENT_ID]);
});

function fakeInstance(instanceId: string) {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const instance = {
    instanceId, driverKind: "openai-compat", displayName: "x", enabled: true,
    models: { default: "other", options: [{ id: "other", label: "other" }] },
    startAuthentication: async () => ({}) as never,
    snapshot: async () => ({ state: "available" as const }),
    adapter: {
      provider: "openai-compat", capabilities: { sessionModelSwitch: "unsupported" as const },
      sendTurn: vi.fn(async () => ({ threadId: "t", turnId: "turn" })),
      interruptTurn: async () => {}, respondToRequest: async () => "unavailable" as const, hasSession: () => false, stopAll: async () => {},
      onEvent: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    dispose: async () => {},
  } as unknown as ProviderInstance;
  return { instance, emit: (event: Partial<RuntimeEvent>) => { for (const listener of listeners) listener({ threadId: "t", turnId: "turn", ...event } as RuntimeEvent); } };
}

it("leaves the person's own engines exactly as they are", () => {
  const policy = includedModelPolicy(gateway(), directory());
  const own = fakeInstance("claude").instance;
  expect(policy.decorate(own)).toBe(own);
  expect(policy.info("claude")).toBeUndefined();
  expect(policy.allows({ instanceId: "claude", model: "anthropic/claude-fixture" })).toBe(false);
});

it("presents included models as signed in and metered, with no sign-in of their own", async () => {
  const policy = includedModelPolicy(gateway(), directory());
  const { instance } = fakeInstance(INCLUDED_AGENT_ID);
  const included = policy.decorate(instance);
  expect(included.models.options.map(option => option.id)).toEqual(["anthropic/claude-fixture", "openai/gpt-fixture"]);
  expect(included.startAuthentication).toBeUndefined();
  expect(included.signOut).toBeUndefined();
  expect(await included.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered", account: { organization: "OMB Cloud Pro" } });
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "ready" });
  await expect(included.adapter.sendTurn({ threadId: "t", text: "hi", model: "someone/else" })).rejects.toThrow(/not included/);
  expect(instance.adapter.sendTurn).not.toHaveBeenCalled();
  await included.adapter.sendTurn({ threadId: "t", text: "hi", model: "openai/gpt-fixture" });
  expect(instance.adapter.sendTurn).toHaveBeenCalledOnce();
});

it("turns the gateway's allowance refusal into one clear state until a turn succeeds", async () => {
  const policy = includedModelPolicy(gateway(), directory());
  const { instance, emit } = fakeInstance(INCLUDED_AGENT_ID);
  const included = policy.decorate(instance), seen: RuntimeEvent[] = [];
  included.adapter.onEvent(event => seen.push(event));
  emit({ type: "runtime.error", message: "OpenAI-compatible HTTP 429: slow down", terminal: false });
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "ready" });
  emit({ type: "runtime.error", message: 'OpenAI-compatible HTTP 402: {"error":{"code":402,"message":"Monthly allowance reached."}}', terminal: false });
  expect(seen.at(-1)).toMatchObject({ type: "runtime.error", message: INCLUDED_ALLOWANCE_MESSAGE, terminal: true });
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "used" });
  expect((await included.snapshot()).warning?.title).toBe("Included AI used up this month");
  emit({ type: "turn.completed", ok: false });
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "used" });
  emit({ type: "turn.completed", ok: true });
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "ready" });
  expect((await included.snapshot()).warning).toBeUndefined();
});

it.each([
  ["OpenAI-compatible HTTP 402: {}", true],
  ['unexpected status 402 Payment Required: {"error":{"type":"budget_exceeded"}}', true],
  ['{"type":"error","error":{"type":"billing_error","message":"Budget reached"}}', true],
  ["stream error: status: 402", true],
  ["OpenAI-compatible HTTP 429: rate limited", false],
  ["HTTP 4020", false],
  ["the model said 402 times", false],
])("recognizes the allowance refusal in %j", (message, expected) => {
  expect(isAllowanceRefusal(message)).toBe(expected);
});

it("runs a real included turn against the gateway and reports a spent allowance plainly", async () => {
  const policy = includedModelPolicy(gateway({ openai: [] }), directory());
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd/openrouter/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
    return new Response(JSON.stringify({ error: { code: 402, message: "Your included AI allowance is used up." } }), { status: 402, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const registry = new ProviderRegistry([OpenAICompatDriver], { npmAvailable: () => false }); registries.push(registry);
  await registry.load(policy.configs(), instance => policy.decorate(instance));
  const included = registry.get(INCLUDED_AGENT_ID)!, events = recordEvents(included.adapter);
  await included.adapter.sendTurn({ threadId: "included-fixture", text: "Synthetic", model: "anthropic/claude-fixture", cwd: directory() });
  await events.until(event => event.type === "turn.completed"); events.stop();
  expect(fetcher).toHaveBeenCalled();
  expect(events.events.filter(event => event.type === "runtime.error").map(event => (event as { message: string }).message)).toEqual([INCLUDED_ALLOWANCE_MESSAGE]);
  expect(policy.info(INCLUDED_AGENT_ID)).toEqual({ state: "used" });
});
