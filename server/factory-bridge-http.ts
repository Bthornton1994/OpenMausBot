/**
 * Local-only factory lane bridge (t1742u / hardened t1743u).
 *
 * Loopback HTTP for CoS/Grok: inspect, register, claim, transition, wait, report.
 * Protect dir is server-config only (COS_FACTORY_PROTECT_DIR / COS_FACTORY_ROOT).
 * Mutating ops fail closed when protect SoT is missing or unreadable.
 * Non-health endpoints require FACTORY_BRIDGE_TOKEN. No CORS. No request protectDir.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";

import {
  claimNextEligible,
  claimWorktree,
  FactoryLaneError,
  getLane,
  laneReport,
  listLanes,
  transition,
  upsertLane,
  waitLane,
  FACTORY_LANE_PHASES,
  type ClaimNextEligibleOptions,
  type FactoryLaneFilter,
  type FactoryLaneInput,
  type FactoryLanePhase,
  type FactoryLanePatch,
} from "./factory-lanes.ts";
import { loadProtectSoT, resolveProtectDir } from "./factory-protect-gate.ts";

export const FACTORY_BRIDGE_HOST = "127.0.0.1";
export const FACTORY_BRIDGE_DEFAULT_PORT = 8798;
export const FACTORY_BRIDGE_MAX_BODY_BYTES = 64 * 1024;
export const FACTORY_BRIDGE_TOKEN_ENV = "FACTORY_BRIDGE_TOKEN";

export type FactoryBridgeLog = (line: string) => void;

export interface FactoryBridgeOptions {
  host?: string;
  port?: number;
  accessLogPath?: string;
  log?: FactoryBridgeLog;
  /** Test-only token override (never log). Production uses FACTORY_BRIDGE_TOKEN. */
  token?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function readConfiguredToken(override?: string): string | null {
  const raw = (override ?? process.env[FACTORY_BRIDGE_TOKEN_ENV] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function requestToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }
  const header = req.headers["x-factory-bridge-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return null;
}

function assertLoopbackHeaders(req: IncomingMessage): void {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || !hostHeader.trim()) {
    throw new FactoryLaneError("invalid", "Host header required");
  }
  const hostOnly = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  // Accept bracketed and unbracketed IPv6 loopback as stored above
  const normalized = hostHeader.trim().toLowerCase().includes("]::")
    ? hostHeader.trim().toLowerCase().replace(/\]:\d+$/, "]")
    : hostOnly;
  const ok =
    LOOPBACK_HOSTS.has(hostOnly) ||
    LOOPBACK_HOSTS.has(normalized) ||
    hostOnly === "127.0.0.1" ||
    hostOnly === "localhost";
  if (!ok) throw new FactoryLaneError("invalid", "Host must be loopback");

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.trim()) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new FactoryLaneError("invalid", "Origin rejected");
    }
    const oHost = parsed.hostname.toLowerCase();
    if (!LOOPBACK_HOSTS.has(oHost) && oHost !== "127.0.0.1" && oHost !== "localhost") {
      throw new FactoryLaneError("invalid", "Origin must be loopback");
    }
  }
}

function requireAuth(req: IncomingMessage, configured: string | null): void {
  if (!configured) throw new FactoryLaneError("invalid", "bridge auth not configured");
  const provided = requestToken(req);
  if (!provided || !tokensEqual(provided, configured)) {
    throw new FactoryLaneError("invalid", "unauthorized");
  }
}

/** Server-config protect dir only — never from the request body. */
export function serverProtectDir(): string {
  const dir = resolveProtectDir(undefined, process.env);
  if (!dir) {
    throw new FactoryLaneError(
      "ineligible",
      "protect SoT unavailable, failing closed: COS_FACTORY_PROTECT_DIR / COS_FACTORY_ROOT not set",
    );
  }
  const loaded = loadProtectSoT(dir);
  if (!loaded.ok) {
    throw new FactoryLaneError("ineligible", `protect SoT unavailable, failing closed: ${loaded.reason}`);
  }
  return dir;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > maxBytes) {
        // Do not destroy before the handler can send 400; stop buffering.
        chunks.length = 0;
        reject(new FactoryLaneError("invalid", `request body exceeds ${maxBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonObject(req: IncomingMessage, { allowEmpty = false } = {}): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "");
  if (type && !/^application\/json\b/i.test(type)) {
    throw new FactoryLaneError("invalid", "Content-Type must be application/json");
  }
  const raw = await readBody(req, FACTORY_BRIDGE_MAX_BODY_BYTES);
  if (!raw.trim()) {
    if (allowEmpty) return {};
    throw new FactoryLaneError("invalid", "request body must be JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FactoryLaneError("invalid", "request body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FactoryLaneError("invalid", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
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
      return error.message === "unauthorized" || error.message === "bridge auth not configured" ? 401 : 400;
    default:
      return 400;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const bad = Object.keys(body).filter((k) => !allowed.includes(k));
  if (bad.length) throw new FactoryLaneError("invalid", `unsupported fields: ${bad.sort().join(", ")}`);
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

const REGISTER_KEYS = ["id", "title", "ownerBotId", "repo", "branch", "worktreePath", "role", "reviewerBotId", "pathClaims"] as const;
const CLAIM_KEYS = ["laneId", "ownerBotId", "repo", "branch", "worktreePath", "pathClaims", "preferOwnerBotId", "forceParallel"] as const;
const WAIT_KEYS = ["timeoutMs", "pollMs", "reload"] as const;
const TRANSITION_KEYS = ["phase", "fullSha", "reviewerBotId", "outcome", "nextAction", "blocker", "prUrl", "changedFiles"] as const;

export async function handleFactoryBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: { log?: FactoryBridgeLog; token?: string } = {},
): Promise<void> {
  const log = options.log ?? ((line: string) => process.stderr.write(`[factory-bridge] ${line}\n`));
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://${FACTORY_BRIDGE_HOST}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const configuredToken = readConfiguredToken(options.token);

  try {
    assertLoopbackHeaders(req);

    if (method === "GET" && path === "/health") {
      send(res, 200, { ok: true, bridge: "factory-lanes", host: FACTORY_BRIDGE_HOST });
      return;
    }

    requireAuth(req, configuredToken);

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
      const body = await readJsonObject(req, { allowEmpty: true });
      assertOnlyKeys(body, WAIT_KEYS);
      const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 1_000;
      const pollMs = typeof body.pollMs === "number" ? body.pollMs : 50;
      const reload = body.reload === true;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
        throw new FactoryLaneError("invalid", "timeoutMs must be 0..120000");
      }
      if (!Number.isFinite(pollMs) || pollMs < 10 || pollMs > 60_000) {
        throw new FactoryLaneError("invalid", "pollMs must be 10..60000");
      }
      const result = await waitLane(decodeURIComponent(wait[1]!), { timeoutMs, pollMs, reload });
      log(`WAIT lane ${result.id} finished=${result.finished} phase=${result.phase}`);
      send(res, 200, { report: result });
      return;
    }

    const transit = path.match(/^\/factory\/lanes\/([^/]+)\/transition$/);
    if (method === "POST" && transit) {
      const protectDir = serverProtectDir();
      const body = await readJsonObject(req);
      assertOnlyKeys(body, TRANSITION_KEYS);
      const phase = str(body.phase);
      if (!phase || !(FACTORY_LANE_PHASES as readonly string[]).includes(phase)) {
        throw new FactoryLaneError("invalid", "phase is required and must be a known factory phase");
      }
      const patch: FactoryLanePatch = {};
      if (str(body.fullSha)) patch.fullSha = str(body.fullSha);
      if (str(body.reviewerBotId)) patch.reviewerBotId = str(body.reviewerBotId);
      if (str(body.outcome)) patch.outcome = str(body.outcome);
      if (body.nextAction !== undefined) patch.nextAction = str(body.nextAction) ?? null;
      if (body.blocker !== undefined) patch.blocker = str(body.blocker) ?? null;
      if (str(body.prUrl)) patch.prUrl = str(body.prUrl);
      if (Array.isArray(body.changedFiles)) patch.changedFiles = body.changedFiles.map(String);
      const lane = transition(decodeURIComponent(transit[1]!), phase as FactoryLanePhase, patch, { protectDir });
      log(`TRANSITION lane=${lane.id} phase=${lane.phase}`);
      send(res, 200, { lane });
      return;
    }

    if (method === "POST" && path === "/factory/claim") {
      const protectDir = serverProtectDir();
      const body = await readJsonObject(req, { allowEmpty: true });
      assertOnlyKeys(body, CLAIM_KEYS);
      if (str(body.laneId) && str(body.ownerBotId) && str(body.repo) && str(body.branch) && str(body.worktreePath)) {
        const lane = claimWorktree({
          laneId: body.laneId as string,
          ownerBotId: body.ownerBotId as string,
          repo: body.repo as string,
          branch: body.branch as string,
          worktreePath: body.worktreePath as string,
          pathClaims: Array.isArray(body.pathClaims) ? body.pathClaims.map(String) : undefined,
          protectDir,
        });
        log(`CLAIM worktree lane=${lane.id} owner=${lane.ownerBotId} phase=${lane.phase}`);
        send(res, 200, { lane, mode: "worktree" });
        return;
      }
      if (str(body.laneId) || str(body.repo) || str(body.branch) || str(body.worktreePath)) {
        throw new FactoryLaneError("invalid", "worktree claim requires laneId, ownerBotId, repo, branch, worktreePath");
      }
      const opts: ClaimNextEligibleOptions = { protectDir };
      if (str(body.preferOwnerBotId)) opts.preferOwnerBotId = str(body.preferOwnerBotId);
      if (body.forceParallel === true) opts.forceParallel = true;
      const lane = claimNextEligible(opts);
      log(`CLAIM next ${lane ? `lane=${lane.id}` : "null"}`);
      send(res, 200, { lane, mode: "nextEligible" });
      return;
    }

    if (method === "POST" && path === "/factory/lanes") {
      serverProtectDir();
      const body = await readJsonObject(req);
      assertOnlyKeys(body, REGISTER_KEYS);
      const input: FactoryLaneInput = {
        title: str(body.title) ?? "",
        ownerBotId: str(body.ownerBotId) ?? "",
        repo: str(body.repo) ?? "",
        branch: str(body.branch) ?? "",
        worktreePath: str(body.worktreePath) ?? "",
      };
      if (str(body.id)) input.id = str(body.id);
      if (str(body.role) === "qa" || str(body.role) === "implementer") input.role = str(body.role) as "qa" | "implementer";
      if (str(body.reviewerBotId)) input.reviewerBotId = str(body.reviewerBotId);
      if (Array.isArray(body.pathClaims)) input.pathClaims = body.pathClaims.map(String);
      // Intentionally omit phase / fullSha / agentSession — callers use /transition.
      const lane = upsertLane(input);
      log(`REGISTER lane=${lane.id} phase=${lane.phase}`);
      send(res, 200, { lane });
      return;
    }

    log(`DENY ${method} ${path}`);
    send(res, 404, {
      error: { code: "unauthorized_op", message: `factory bridge does not expose ${method} ${path}` },
    });
  } catch (error) {
    if (error instanceof FactoryLaneError) {
      const safe = error.message === "unauthorized" || error.message === "bridge auth not configured"
        ? error.message
        : error.message.includes("protect SoT")
          ? error.message
          : error.message;
      log(`ERR ${error.code}: ${safe}`);
      send(res, statusFor(error), { error: { code: error.code, message: safe } });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`ERR internal: ${message}`);
    send(res, 500, { error: { code: "internal", message: "internal error" } });
  }
}

export function createFactoryBridgeServer(options: FactoryBridgeOptions = {}): Server {
  const host = options.host ?? FACTORY_BRIDGE_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`factory bridge refuses non-loopback host ${host}`);
  }
  const log = options.log ?? defaultLog(options.accessLogPath);
  const token = options.token;
  return createServer((req, res) => {
    void handleFactoryBridgeRequest(req, res, { log, token });
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
