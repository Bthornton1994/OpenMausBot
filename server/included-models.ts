// Models included with OMB Cloud Pro. On a Cloud home machine they sit
// beside the person's own engines, never in place of them: the person can
// still sign in to their own Claude or Codex on the machine, and those
// logins stay on its volume.
//
// Every included request goes through the Admin's metered gateway with the
// machine's own revocable key (cloud-home.ts). Claude Code never receives
// that key: included Claude models are offered through OpenRouter and run
// in OpenMausBot's own agent (the openai-compat driver). Codex runs with the
// key as its custom provider, which is how the Codex CLI takes an API key.
//
// When the month's allowance is spent the gateway answers 402; the turn's
// error becomes one plain sentence and the picker says so, until a later
// turn succeeds again.
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "./contracts.ts";
import type { CloudHomeGateway } from "./cloud-home.ts";

export const INCLUDED_PREFIX = "included.";
export const INCLUDED_AGENT_ID = "included.agent";
export const INCLUDED_CODEX_ID = "included.codex";
export const INCLUDED_ALLOWANCE_TITLE = "Included AI used up this month";
export const INCLUDED_ALLOWANCE_MESSAGE =
  "Included AI used up this month. Your bots can keep going on your own Claude or Codex: sign in under Settings → Engines on your Cloud. Included models come back when your allowance resets.";
export const INCLUDED_READ_ONLY_ERROR = "Included models are part of OMB Cloud Pro and can't be changed here.";

export function isIncludedInstanceId(instanceId: string): boolean {
  return instanceId.startsWith(INCLUDED_PREFIX);
}

/** The gateway's allowance refusal, as each driver reports it: the
 * OpenAI-compatible agent says "HTTP 402", Codex prints the status line or
 * the provider-shaped body the gateway sends (budget_exceeded / billing_error). */
export function isAllowanceRefusal(message: string): boolean {
  return /\bHTTP 402\b|\b402 Payment Required\b|\bstatus[: ]+402\b|\bbudget_exceeded\b|\bbilling_error\b/i.test(message);
}

export interface IncludedInfo { state: "ready" | "used" }

export function includedModelPolicy(gateway: CloudHomeGateway, dataDirectory: string) {
  const ids: string[] = [];
  if (gateway.openrouter.length) ids.push(INCLUDED_AGENT_ID);
  if (gateway.openai.length) ids.push(INCLUDED_CODEX_ID);
  const modelsFor = (instanceId: string): string[] =>
    instanceId === INCLUDED_AGENT_ID ? gateway.openrouter : instanceId === INCLUDED_CODEX_ID ? gateway.openai : [];
  let used = false;

  const home = (name: string) => {
    let directory = dataDirectory;
    for (const part of ["providers", "included", name]) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Included model storage must be an owned directory.");
    }
    return directory;
  };

  return {
    ids: () => [...ids],
    owns: (instanceId: string) => ids.includes(instanceId),
    info: (instanceId: string): IncludedInfo | undefined => ids.includes(instanceId) ? { state: used ? "used" : "ready" } : undefined,
    allows: (selection: ModelSelection) => modelsFor(selection.instanceId).includes(selection.model),
    configs(): InstanceConfigMap {
      const configs: InstanceConfigMap = {};
      if (gateway.openrouter.length) configs[INCLUDED_AGENT_ID] = {
        driver: "openai-compat", displayName: "OMB Cloud",
        config: { url: `${gateway.base}/openrouter/v1`, apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY", provider: "", model: gateway.openrouter[0], managedModels: gateway.openrouter },
        environment: { OPENMAUSBOT_COMPANY_API_KEY: gateway.token },
      };
      if (gateway.openai.length) configs[INCLUDED_CODEX_ID] = {
        driver: "codex", displayName: "OMB Cloud · Codex",
        config: { cli: "codex", managed: { url: `${gateway.base}/openai/v1`, models: gateway.openai } },
        environment: { OPENMAUSBOT_COMPANY_API_KEY: gateway.token, CODEX_HOME: home("codex") },
      };
      return configs;
    },
    /** Pass-through for the person's own instances. */
    decorate(instance: ProviderInstance): ProviderInstance {
      if (!ids.includes(instance.instanceId)) return instance;
      const models = modelsFor(instance.instanceId);
      return {
        ...instance,
        models: { default: models[0], options: models.map((id) => ({ id, label: id })) },
        refreshModels: async () => {},
        installRuntime: undefined, startAuthentication: undefined, getAuthentication: undefined,
        completeAuthentication: undefined, cancelAuthentication: undefined, signOut: undefined,
        snapshot: async () => {
          const snapshot = await instance.snapshot();
          return {
            ...snapshot, authenticated: true, billing: "metered", account: { organization: "OMB Cloud Pro", method: "api-key" },
            ...(used ? { warning: { title: INCLUDED_ALLOWANCE_TITLE, message: INCLUDED_ALLOWANCE_MESSAGE } } : {}),
          };
        },
        adapter: {
          ...instance.adapter,
          sendTurn: async (input) => {
            if (!input.model || !models.includes(input.model)) throw new Error("This model is not included with your plan. Choose one of the included models.");
            return instance.adapter.sendTurn(input);
          },
          onEvent: (listener) => instance.adapter.onEvent((event) => {
            if (event.type === "runtime.error" && isAllowanceRefusal(event.message)) {
              used = true;
              listener({ ...event, message: INCLUDED_ALLOWANCE_MESSAGE, terminal: true });
              return;
            }
            if (event.type === "turn.completed" && event.ok) used = false;
            listener(event);
          }),
        },
      };
    },
  };
}

export type IncludedModelPolicy = ReturnType<typeof includedModelPolicy>;
