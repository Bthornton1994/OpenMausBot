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
/** F6/t1749u: whole-body read deadline; a slow client cannot hold a read open. */
export const FACTORY_BRIDGE_BODY_TIMEOUT_MS = 10_000;
/** F6/t1749u: after a rejected body, drain this long so the 400 can flush, then cut the socket. */
export const FACTORY_BRIDGE_BODY_DRAIN_MS = 1_000;
export const FACTORY_BRIDGE_TOKEN_ENV = "FACTORY_BRIDGE_TOKEN";

export type FactoryBridgeLog = (line: string) => void;

export interface FactoryBridgeOptions {
  host?: string;
  port?: number;
  accessLogPath?: string;
  log?: FactoryBridgeLog;
  /** Test-only token override (never log). Production uses FACTORY_BRIDGE_TOKEN. */
  token?: string;
  /** Test-only override of FACTORY_BRIDGE_BODY_TIMEOUT_MS. */
  bodyTimeoutMs?: number;
  /** Test-only override of FACTORY_BRIDGE_BODY_DRAIN_MS. */
  bodyDrainMs?: number;
}

interface BodyLimits {
  timeoutMs?: number;
  drainMs?: number;
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

/** F7/t1750u: startup status for the protect dir. Names the env var that set
 * it, never the path. Mirrors resolveProtectDir precedence. */
export function formatProtectDirStatus(env: NodeJS.ProcessEnv = process.env): string {
  if (!resolveProtectDir(undefined, env)) return "unset — mutating ops fail closed";
  return env.COS_FACTORY_PROTECT_DIR?.trim()
    ? "configured (COS_FACTORY_PROTECT_DIR)"
    : "configured (COS_FACTORY_ROOT)";
}

/** F7/t1750u: startup status for the data dir, never the path. Mirrors DATA_DIR's `??`. */
export function formatDataDirStatus(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMB_DATA_DIR !== undefined ? "configured (OMB_DATA_DIR)" : "default (~/.openmausbot)";
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

function readBody(req: IncomingMessage, maxBytes: number, limits: BodyLimits = {}): Promise<string> {
  const timeoutMs = limits.timeoutMs ?? FACTORY_BRIDGE_BODY_TIMEOUT_MS;
  const drainMs = limits.drainMs ?? FACTORY_BRIDGE_BODY_DRAIN_MS;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => abort(new FactoryLaneError("invalid", "request body read timed out")), timeoutMs);
    timer.unref();

    // F6/t1749u: never destroy synchronously — the handler must get to send
    // the 400 (t1743u). Drain for a short window, then cut the socket so a
    // slow client cannot hold it open.
    function abort(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      reject(error);
      req.resume();
      const cutoff = setTimeout(() => req.destroy(), drainMs);
      cutoff.unref();
      req.once("close", () => clearTimeout(cutoff));
    }

    req.on("data", (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > maxBytes) {
        abort(new FactoryLaneError("invalid", `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      reject(error);
    });
  });
}

async function readJsonObject(
  req: IncomingMessage,
  { allowEmpty = false, limits = {} as BodyLimits } = {},
): Promise<Record<string, unknown>> {
  // F3/t1746u: a missing Content-Type is rejected too, so a simple
  // cross-origin request cannot reach a mutating route.
  const type = String(req.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) {
    throw new FactoryLaneError("invalid", "Content-Type must be application/json");
  }
  const raw = await readBody(req, FACTORY_BRIDGE_MAX_BODY_BYTES, limits);
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

// F4: reject non-string entries rather than String()-coercing them ("[object Object]").
function parseStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new FactoryLaneError("invalid", `${field} must be an array of strings`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new FactoryLaneError("invalid", `${field} must be an array of non-empty strings`);
    }
    return entry.trim();
  });
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
  options: { log?: FactoryBridgeLog; token?: string; bodyTimeoutMs?: number; bodyDrainMs?: number } = {},
): Promise<void> {
  const limits: BodyLimits = { timeoutMs: options.bodyTimeoutMs, drainMs: options.bodyDrainMs };
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
      const body = await readJsonObject(req, { allowEmpty: true, limits });
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
      const body = await readJsonObject(req, { limits });
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
      const changedFiles = parseStringList(body.changedFiles, "changedFiles");
      if (changedFiles) patch.changedFiles = changedFiles;
      const lane = transition(decodeURIComponent(transit[1]!), phase as FactoryLanePhase, patch, { protectDir });
      log(`TRANSITION lane=${lane.id} phase=${lane.phase}`);
      send(res, 200, { lane });
      return;
    }

    if (method === "POST" && path === "/factory/claim") {
      const protectDir = serverProtectDir();
      const body = await readJsonObject(req, { allowEmpty: true, limits });
      assertOnlyKeys(body, CLAIM_KEYS);
      const pathClaims = parseStringList(body.pathClaims, "pathClaims");
      if (str(body.laneId) && str(body.ownerBotId) && str(body.repo) && str(body.branch) && str(body.worktreePath)) {
        const lane = claimWorktree({
          laneId: body.laneId as string,
          ownerBotId: body.ownerBotId as string,
          repo: body.repo as string,
          branch: body.branch as string,
          worktreePath: body.worktreePath as string,
          pathClaims,
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
      const body = await readJsonObject(req, { limits });
      assertOnlyKeys(body, REGISTER_KEYS);
      const pathClaims = parseStringList(body.pathClaims, "pathClaims");
      const input: FactoryLaneInput = {
        title: str(body.title) ?? "",
        ownerBotId: str(body.ownerBotId) ?? "",
        repo: str(body.repo) ?? "",
        branch: str(body.branch) ?? "",
        worktreePath: str(body.worktreePath) ?? "",
      };
      if (str(body.id)) input.id = str(body.id);
      // F1: register is create-only — never update an existing lane via upsert.
      if (input.id && getLane(input.id)) {
        throw new FactoryLaneError("conflict", `lane ${input.id} already exists; register cannot update`);
      }
      if (str(body.role) === "qa" || str(body.role) === "implementer") input.role = str(body.role) as "qa" | "implementer";
      if (str(body.reviewerBotId)) input.reviewerBotId = str(body.reviewerBotId);
      if (pathClaims) input.pathClaims = pathClaims;
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
      log(`ERR ${error.code}: ${error.message}`);
      send(res, statusFor(error), { error: { code: error.code, message: clientErrorMessage(error) } });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log(`ERR internal: ${message}`);
    send(res, 500, { error: { code: "internal", message: "internal error" } });
  }
}

const PROTECT_SOT_CLIENT_MESSAGE = "protect SoT unavailable, failing closed";
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`,;)]*/g;
const POSIX_PATH = /(?<![\w.:/~-])\/[^\s"'`,;:)/]+(?:\/[^\s"'`,;:)]*)*/g;

/**
 * Client-facing error text. Full detail stays in the server log; HTTP clients
 * never see filesystem paths (protect dir, worktrees, temp dirs).
 */
export function clientErrorMessage(error: FactoryLaneError): string {
  if (error.message.includes("protect SoT")) return PROTECT_SOT_CLIENT_MESSAGE;
  let message = error.message;
  const protectDir = process.env.COS_FACTORY_PROTECT_DIR?.trim();
  if (protectDir) message = message.split(protectDir).join("<path>");
  return message.replace(WINDOWS_PATH, "<path>").replace(POSIX_PATH, "<path>");
}

export function createFactoryBridgeServer(options: FactoryBridgeOptions = {}): Server {
  const host = options.host ?? FACTORY_BRIDGE_HOST;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`factory bridge refuses non-loopback host ${host}`);
  }
  const log = options.log ?? defaultLog(options.accessLogPath);
  const { token, bodyTimeoutMs, bodyDrainMs } = options;
  return createServer((req, res) => {
    void handleFactoryBridgeRequest(req, res, { log, token, bodyTimeoutMs, bodyDrainMs });
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
