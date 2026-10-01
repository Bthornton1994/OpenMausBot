/**
 * Local-only factory lane bridge (t1742u).
 *
 * Loopback HTTP surface for CoS/Grok coordination: inspect, claim, wait, report.
 * Reuses factory-lanes + factory-protect-gate. Does not expose settings,
 * credentials, permission grants, deletion, computer lifecycle, merge, deploy,
 * or publication.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  claimNextEligible,
  claimWorktree,
  FactoryLaneError,
  getLane,
  laneReport,
  listLanes,
  upsertLane,
  waitLane,
  type ClaimNextEligibleOptions,
  type FactoryLane,
  type FactoryLaneFilter,
  type FactoryLaneInput,
} from "./factory-lanes.ts";

export const FACTORY_BRIDGE_HOST = "127.0.0.1";
export const FACTORY_BRIDGE_DEFAULT_PORT = 8798;

export type FactoryBridgeLog = (line: string) => void;

export interface FactoryBridgeOptions {
  host?: string;
  port?: number;
  /** Optional access log path (append-only). */
  accessLogPath?: string;
  log?: FactoryBridgeLog;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new FactoryLaneError("invalid", "request body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function statusFor(error: FactoryLaneError): number {
  switch (error.code) {
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "ineligible":
    case "qa_independence":
      return 403;
    case "terminal":
    case "invalid":
      return 400;
    default:
      return 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function defaultLog(accessLogPath: string | undefined): FactoryBridgeLog {
  if (!accessLogPath) return (line) => process.stderr.write(`[factory-bridge] ${line}\n`);
  mkdirSync(dirname(accessLogPath), { recursive: true });
  return (line) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`[factory-bridge] ${line}\n`);
    appendFileSync(accessLogPath, stamped);
  };
}

/** Route table Ã¢â‚¬â€ keep this the single allowlist of exposed ops. */
export async function handleFactoryBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { log?: FactoryBridgeLog } = {},
): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`[factory-bridge] ${line}\n`));
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://${FACTORY_BRIDGE_HOST}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (method === "GET" && path === "/health") {
      send(res, 200, { ok: true, bridge: "factory-lanes", host: FACTORY_BRIDGE_HOST });
      return;
    }

    if (method === "GET" && path === "/factory/lanes") {
      const filter: FactoryLaneFilter = {};
      const phase = url.searchParams.get("phase");
      if (phase) filter.phase = phase.split(",").map((p) => p.trim()).filter(Boolean) as FactoryLaneFilter["phase"];
      const ownerBotId = url.searchParams.get("ownerBotId");
      if (ownerBotId) filter.ownerBotId = ownerBotId;
      const repo = url.searchParams.get("repo");
      if (repo) filter.repo = repo;
      if (url.searchParams.get("includeTerminal") === "1") filter.includeTerminal = true;
      const lanes = listLanes(filter);
      log(`LIST lanes count=${lanes.length}`);
      send(res, 200, { lanes });
      return;
    }

    const one = path.match(/^\/factory\/lanes\/([^/]+)$/);
    if (method === "GET" && one) {
      const lane = getLane(decodeURIComponent(one[1]!));
      if (!lane) throw new FactoryLaneError("not_found", `no factory lane ${one[1]}`);
      log(`GET lane ${lane.id} phase=${lane.phase}`);
      send(res, 200, { lane });
      return;
    }

    const report = path.match(/^\/factory\/lanes\/([^/]+)\/report$/);
    if (method === "GET" && report) {
      const lane = getLane(decodeURIComponent(report[1]!));
      if (!lane) throw new FactoryLaneError("not_found", `no factory lane ${report[1]}`);
      log(`REPORT lane ${lane.id} phase=${lane.phase}`);
      send(res, 200, { report: laneReport(lane) });
      return;
    }

    const wait = path.match(/^\/factory\/lanes\/([^/]+)\/wait$/);
    if (method === "POST" && wait) {
      const body = await readJson(req);
      const timeoutMs = isRecord(body) && typeof body.timeoutMs === "number" ? body.timeoutMs : 1_000;
      const pollMs = isRecord(body) && typeof body.pollMs === "number" ? body.pollMs : 50;
      const reload = isRecord(body) ? body.reload === true : false;
      if (timeoutMs < 0 || timeoutMs > 120_000) throw new FactoryLaneError("invalid", "timeoutMs must be 0..120000");
      const result = await waitLane(decodeURIComponent(wait[1]!), { timeoutMs, pollMs, reload });
      log(`WAIT lane ${result.id} finished=${result.finished} phase=${result.phase}`);
      send(res, 200, { report: result });
      return;
    }

    if (method === "POST" && path === "/factory/claim") {
      const body = await readJson(req);
      if (!isRecord(body)) throw new FactoryLaneError("invalid", "claim body must be an object");
      const protectDir = str(body.protectDir);
      // Explicit worktree claim
      if (str(body.laneId) && str(body.ownerBotId) && str(body.repo) && str(body.branch) && str(body.worktreePath)) {
        const lane = claimWorktree({
          laneId: body.laneId as string,
          ownerBotId: body.ownerBotId as string,
          repo: body.repo as string,
          branch: body.branch as string,
          worktreePath: body.worktreePath as string,
          pathClaims: Array.isArray(body.pathClaims) ? (body.pathClaims as string[]) : undefined,
          protectDir,
        });
        log(`CLAIM worktree lane=${lane.id} owner=${lane.ownerBotId} phase=${lane.phase}`);
        send(res, 200, { lane, mode: "worktree" });
        return;
      }
      // Next eligible
      const opts: ClaimNextEligibleOptions = { protectDir };
      if (str(body.preferOwnerBotId)) opts.preferOwnerBotId = str(body.preferOwnerBotId);
      if (body.forceParallel === true) opts.forceParallel = true;
      const lane = claimNextEligible(opts);
      log(`CLAIM next ${lane ? `lane=${lane.id}` : "null"}`);
      send(res, 200, { lane, mode: "nextEligible" });
      return;
    }

    if (method === "POST" && path === "/factory/lanes") {
      const body = await readJson(req);
      if (!isRecord(body)) throw new FactoryLaneError("invalid", "lane body must be an object");
      const input: FactoryLaneInput = {
        title: str(body.title) ?? "",
        ownerBotId: str(body.ownerBotId) ?? "",
        repo: str(body.repo) ?? "",
        branch: str(body.branch) ?? "",
        worktreePath: str(body.worktreePath) ?? "",
      };
      if (str(body.id)) input.id = str(body.id);
      if (str(body.role) === "qa" || str(body.role) === "implementer") input.role = str(body.role) as "qa" | "implementer";
      if (str(body.fullSha)) input.fullSha = str(body.fullSha);
      if (str(body.reviewerBotId)) input.reviewerBotId = str(body.reviewerBotId);
      if (str(body.agentSession)) input.agentSession = str(body.agentSession);
      if (str(body.phase)) input.phase = str(body.phase) as FactoryLane["phase"];
      const lane = upsertLane(input);
      log(`UPSERT lane=${lane.id} phase=${lane.phase}`);
      send(res, 200, { lane });
      return;
    }

    // Anything else is unauthorized for this bridge.
    log(`DENY ${method} ${path}`);
    send(res, 404, {
      error: { code: "unauthorized_op", message: `factory bridge does not expose ${method} ${path}` },
    });
  } catch (error) {
    if (error instanceof FactoryLaneError) {
      log(`ERR ${error.code}: ${error.message}`);
      send(res, statusFor(error), { error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`ERR internal: ${message}`);
    send(res, 500, { error: { code: "internal", message } });
  }
}

export function createFactoryBridgeServer(options: FactoryBridgeOptions = {}): Server {
  const host = options.host ?? FACTORY_BRIDGE_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`factory bridge refuses non-loopback host ${host}`);
  }
  const log = options.log ?? defaultLog(options.accessLogPath);
  return createServer((req, res) => {
    void handleFactoryBridgeRequest(req, res, { log });
  });
}

export async function listenFactoryBridge(options: FactoryBridgeOptions = {}): Promise<{ server: Server; url: string }> {
  const host = options.host ?? FACTORY_BRIDGE_HOST;
  const port = options.port ?? FACTORY_BRIDGE_DEFAULT_PORT;
  const server = createFactoryBridgeServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const bound = addr && typeof addr !== "string" ? addr.port : port;
  const url = `http://${host}:${bound}`;
  (options.log ?? defaultLog(options.accessLogPath))(`listening on ${url}`);
  return { server, url };
}