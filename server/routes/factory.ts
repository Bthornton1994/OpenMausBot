// Factory HTTP. Authenticated with the rest of the route table. The store
// is factory-dispatch.ts; this file only translates requests.
import { existsSync } from "node:fs";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import {
  FACTORY_ONBOARDING,
  FactoryDispatchError,
  cancelFactoryTask,
  createFactoryTask,
  getFactoryTask,
  deliverHandoff,
  harvestFactoryTask,
  launchFactoryTask,
  shipFactoryTask,
  listFactoryTasks,
  portfolioDocument,
  recoverFactoryTasks,
  unavailableFactoryRoles,
  viewTask,
  waitFactoryTask,
  type FactoryBot,
  type FactoryStatus,
} from "../factory-dispatch.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface FactoryRouteDeps {
  bot: (id: string) => FactoryBot | null;
  createThread: (botId: string, title: string) => { threadId: string };
  pinCwd: (botId: string, threadId: string, cwd: string) => void;
  startTurn: (botId: string, text: string, threadId: string) => Promise<unknown>;
}

function fail(error: unknown): { status: number; body: { error: string; code?: string; task?: ReturnType<typeof viewTask> } } {
  if (error instanceof FactoryDispatchError) {
    const status = error.code === "not_found" ? 404
      : error.code === "conflict" ? 409
      : error.code === "role_unavailable" ? 409
      : error.code === "blocked" ? 409
      : error.code === "mismatch" ? 409
      : error.code === "ineligible" ? 409
      : 400;
    return { status, body: { error: error.message, code: error.code, ...(error.task ? { task: viewTask(error.task) } : {}) } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : "factory request failed" } };
}

export function createFactoryRoutes(deps: FactoryRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (!path.startsWith("/api/factory")) return PASS;
    try {
      if (method === "GET" && path === "/api/factory/tasks") {
        return json(res, 200, { tasks: listFactoryTasks(), unavailableRoles: unavailableFactoryRoles() });
      }
      if (method === "GET" && path === "/api/factory/portfolio") {
        return json(res, 200, portfolioDocument());
      }
      if (method === "GET" && path === "/api/factory/onboarding") {
        return json(res, 200, { markdown: FACTORY_ONBOARDING });
      }
      if (method === "POST" && path === "/api/factory/recover") {
        return json(res, 200, recoverFactoryTasks());
      }
      if (method === "POST" && path === "/api/factory/tasks") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
        const created = createFactoryTask(body, {
          bot: deps.bot,
          createThread: deps.createThread,
          pinCwd: deps.pinCwd,
          boundaryEnforced: (bot) => bot.driverKind === "claudeAgent" && existsSync(SPAWNED_PROXIES.factoryBoundary),
        });
        return json(res, created.duplicate ? 200 : 201, { task: viewTask(created.task), duplicate: created.duplicate });
      }
      const one = path.match(/^\/api\/factory\/tasks\/([\w-]+)$/);
      if (one && method === "GET") {
        const task = getFactoryTask(one[1]!);
        if (!task) return json(res, 404, { error: "no such factory task" });
        return json(res, 200, { task: viewTask(task) });
      }
      const launch = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/launch$/);
      if (launch && method === "POST") {
        const result = await launchFactoryTask(launch[1]!, {
          start: async (task) => {
            if (!task.ombThreadId) throw new FactoryDispatchError("blocked", "factory task has no thread");
            await deps.startTurn(task.specialistId, task.objective, task.ombThreadId);
          },
        });
        return json(res, 200, { task: viewTask(result.task), duplicate: result.duplicate });
      }
      const harvest = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/harvest$/);
      if (harvest && method === "POST") {
        const body = await readBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
        const task = harvestFactoryTask(harvest[1]!, body);
        return json(res, 200, { task: viewTask(task) });
      }
      const wait = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/wait$/);
      if (wait && method === "POST") {
        const body = await readBody(req);
        const status = body && typeof body === "object" && !Array.isArray(body) ? (body as { status?: unknown }).status : undefined;
        if (typeof status !== "string") return json(res, 400, { error: "status is required" });
        const task = waitFactoryTask(wait[1]!, status as FactoryStatus);
        return json(res, 200, { task: viewTask(task) });
      }
      const deliver = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/deliver$/);
      if (deliver && method === "POST") {
        const result = await deliverHandoff(deliver[1]!, {
          bot: deps.bot,
          createThread: deps.createThread,
          pinCwd: deps.pinCwd,
          start: async (task) => {
            if (!task.ombThreadId) throw new FactoryDispatchError("blocked", "factory task has no thread");
            const handoff = [...(task.handoffs ?? [])].reverse().find((item) => item.deliveredAt);
            const text = handoff
              ? [
                  task.objective,
                  `Handoff ${handoff.stage} on factory task ${task.id}.`,
                  `Repo ${handoff.repo}. Worktree ${handoff.worktree}.`,
                  `Input SHA ${handoff.inputSha}. Result SHA ${handoff.resultSha}.`,
                  `From ${handoff.fromSpecialistId} to ${handoff.toSpecialistId}.`,
                  handoff.summary,
                  `Required evidence: ${handoff.requiredEvidence.join(", ") || "none"}.`,
                  handoff.findings.length ? `Findings: ${handoff.findings.join("; ")}` : "Findings: none.",
                  handoff.nextAction,
                  "Stay inside this worktree. Do not merge, push, or claim the task is shipped.",
                ].join("\n")
              : task.objective;
            await deps.startTurn(task.specialistId, text, task.ombThreadId);
          },
        });
        return json(res, 200, { task: viewTask(result.task), duplicate: result.duplicate, handoffs: result.task.handoffs ?? [] });
      }
      const ship = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/ship$/);
      if (ship && method === "POST") {
        const body = await readBody(req);
        const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const task = shipFactoryTask(ship[1]!, raw);
        return json(res, 200, { task: viewTask(task) });
      }
      const cancel = path.match(/^\/api\/factory\/tasks\/([\w-]+)\/cancel$/);
      if (cancel && method === "POST") {
        return json(res, 200, { task: viewTask(cancelFactoryTask(cancel[1]!)) });
      }
      return json(res, 404, { error: "no such factory route" });
    } catch (error) {
      const failed = fail(error);
      return json(res, failed.status, failed.body);
    }
  };
}
