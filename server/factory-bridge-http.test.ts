/**
 * Focused factory bridge HTTP tests (t1742u + t1743u harden).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  clientErrorMessage,
  formatDataDirStatus,
  formatProtectDirStatus,
  listenFactoryBridge,
  FACTORY_BRIDGE_BODY_DRAIN_MS,
  FACTORY_BRIDGE_BODY_TIMEOUT_MS,
  FACTORY_BRIDGE_MAX_BODY_BYTES,
} from "./factory-bridge-http.ts";
import {
  FactoryLaneError,
  listLanes,
  recordQaDisposition,
  transition,
  upsertLane,
  _resetFactoryLanes,
  getLane,
} from "./factory-lanes.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t1734u-protect");
const VA = { repo: "Bthornton1994/Virtual-Assistant", branch: "cos/rr-d1d4-operator-only-19d4f99e" };
const VA_TIP = "ca813c0dd29e5c38063efa571d809b0dbd5a4bfb";
const SHA = "c".repeat(40);
const TOKEN = "t1743u-test-token-not-a-secret-for-prod";

function laneInput(suffix: string, overrides: Partial<Parameters<typeof upsertLane>[0]> = {}) {
  return {
    title: `Lane ${suffix}`,
    ownerBotId: `implementer-${suffix}`,
    repo: "acme/widgets",
    branch: `feature/${suffix}`,
    worktreePath: `C:\\work\\wt-${suffix}`,
    ...overrides,
  };
}

async function json(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${TOKEN}`,
      ...headers,
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * Raw socket POST that keeps streaming (or stalls) per `drive`. Resolves with
 * the response text once the server closes the connection.
 */
function rawPost(
  base: string,
  contentLength: number,
  drive: (socket: Socket) => () => void,
): Promise<{ response: string; closedAfterMs: number }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = connect(Number(port), hostname);
    let response = "";
    let stop: () => void = () => {};
    socket.setEncoding("utf8");
    socket.on("data", (d) => (response += d));
    socket.on("error", () => {});
    socket.on("close", () => {
      stop();
      resolve({ response, closedAfterMs: Date.now() - started });
    });
    socket.on("connect", () => {
      socket.write(
        [
          "POST /factory/claim HTTP/1.1",
          `Host: ${hostname}:${port}`,
          `Authorization: Bearer ${TOKEN}`,
          "Content-Type: application/json",
          `Content-Length: ${contentLength}`,
          "",
          "",
        ].join("\r\n"),
      );
      stop = drive(socket);
    });
  });
}

describe("factory bridge HTTP (t1742u/t1743u)", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};

  beforeEach(async () => {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const name of readdirSync(DATA_DIR)) {
      if (name.startsWith("factory-lanes.json") || name.startsWith("protect-") || name === "bridge.log") {
        rmSync(join(DATA_DIR, name), { recursive: true, force: true });
      }
    }
    _resetFactoryLanes();
    process.env.COS_FACTORY_PROTECT_DIR = FIXTURE;
    process.env.FACTORY_BRIDGE_TOKEN = TOKEN;
    const { server, url } = await listenFactoryBridge({
      port: 0,
      accessLogPath: join(DATA_DIR, "bridge.log"),
      token: TOKEN,
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    base = `http://127.0.0.1:${addr.port}`;
    close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    void url;
  });

  afterEach(async () => {
    await close();
    delete process.env.COS_FACTORY_PROTECT_DIR;
    delete process.env.FACTORY_BRIDGE_TOKEN;
    _resetFactoryLanes();
  });

  it("lists lanes and rejects unauthorized ops", async () => {
    upsertLane(laneInput("a"));
    const listed = await json(base, "GET", "/factory/lanes");
    expect(listed.status).toBe(200);
    expect(listed.body.lanes).toHaveLength(1);

    const denied = await json(base, "DELETE", "/factory/lanes/x");
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("unauthorized_op");

    const merge = await json(base, "POST", "/factory/merge", { pr: 1 });
    expect(merge.status).toBe(404);
    expect(merge.body.error.code).toBe("unauthorized_op");
  });

  it("health is unauthenticated; other routes require auth with no state change", async () => {
    upsertLane(laneInput("seed", { fullSha: SHA }));
    const before = listLanes().length;
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const noAuth = await fetch(`${base}/factory/lanes`);
    expect(noAuth.status).toBe(401);
    const bad = await json(base, "POST", "/factory/claim", {}, { authorization: "Bearer wrong-token" });
    expect(bad.status).toBe(401);
    expect(listLanes().length).toBe(before);
    expect(listLanes().every((l) => l.phase === "ready")).toBe(true);
  });

  it("cannot override protectDir via request; bad SoT denies mutating ops", async () => {
    const ready = upsertLane(laneInput("ready", { fullSha: SHA }));
    const attempt = await json(base, "POST", "/factory/claim", {
      laneId: ready.id,
      ownerBotId: ready.ownerBotId,
      repo: ready.repo,
      branch: ready.branch,
      worktreePath: ready.worktreePath,
      protectDir: "C:\\evil\\protect",
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.message).toMatch(/unsupported fields: protectDir/);
    expect(getLane(ready.id)?.phase).toBe("ready");
    expect(getLane(ready.id)?.claimedAt).toBeUndefined();

    delete process.env.COS_FACTORY_PROTECT_DIR;
    const denied = await json(base, "POST", "/factory/claim", {});
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("ineligible");
    expect(denied.body.error.message).toMatch(/failing closed/);
    process.env.COS_FACTORY_PROTECT_DIR = FIXTURE;

    const missing = join(DATA_DIR, "protect-missing");
    mkdirSync(missing, { recursive: true });
    process.env.COS_FACTORY_PROTECT_DIR = missing;
    const badSot = await json(base, "POST", "/factory/lanes", {
      title: "x",
      ownerBotId: "o",
      repo: "r/r",
      branch: "b",
      worktreePath: "C:\\w",
    });
    expect(badSot.status).toBe(403);
    expect(badSot.body.error.message).toMatch(/failing closed/);
    process.env.COS_FACTORY_PROTECT_DIR = FIXTURE;
  });

  it("rejects oversized, non-JSON, and malformed bodies", async () => {
    const huge = await json(base, "POST", "/factory/claim", "x".repeat(FACTORY_BRIDGE_MAX_BODY_BYTES + 10));
    expect(huge.status).toBe(400);

    const badJson = await fetch(`${base}/factory/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);

    const wrongType = await fetch(`${base}/factory/claim`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${TOKEN}` },
      body: "{}",
    });
    expect(wrongType.status).toBe(400);
  });

  it("F6 exports body timeout and drain constants", () => {
    expect(FACTORY_BRIDGE_BODY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(FACTORY_BRIDGE_BODY_DRAIN_MS).toBeGreaterThan(0);
    expect(FACTORY_BRIDGE_BODY_DRAIN_MS).toBeLessThan(FACTORY_BRIDGE_BODY_TIMEOUT_MS);
  });

  it("F6 oversize body gets 400 then the socket is cut while the client keeps streaming", async () => {
    const chunk = "x".repeat(8 * 1024);
    const { response, closedAfterMs } = await rawPost(base, 100 * 1024 * 1024, (socket) => {
      socket.write("x".repeat(FACTORY_BRIDGE_MAX_BODY_BYTES + 10));
      const interval = setInterval(() => {
        if (!socket.destroyed) socket.write(chunk);
      }, 50);
      return () => clearInterval(interval);
    });
    expect(response).toMatch(/^HTTP\/1\.1 400/);
    expect(response).toMatch(/request body exceeds/);
    expect(closedAfterMs).toBeLessThan(FACTORY_BRIDGE_BODY_DRAIN_MS + 3000);
  }, 10_000);

  it("F6 stalled body read times out with 400 and the socket is cut", async () => {
    const { server } = await listenFactoryBridge({
      port: 0,
      accessLogPath: join(DATA_DIR, "bridge.log"),
      token: TOKEN,
      bodyTimeoutMs: 200,
      bodyDrainMs: 200,
    });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("expected TCP address");
      const { response, closedAfterMs } = await rawPost(`http://127.0.0.1:${addr.port}`, 100, (socket) => {
        socket.write('{"partial":');
        return () => {};
      });
      expect(response).toMatch(/^HTTP\/1\.1 400/);
      expect(response).toMatch(/request body read timed out/);
      expect(closedAfterMs).toBeLessThan(3000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("F3 requires application/json Content-Type on writes", async () => {
    // A Uint8Array body makes fetch send no Content-Type header at all.
    const noType = await fetch(`${base}/factory/lanes`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: new TextEncoder().encode(JSON.stringify(laneInput("f3-none"))),
    });
    expect(noType.status).toBe(400);
    const noTypeBody: any = await noType.json();
    expect(noTypeBody.error.message).toMatch(/Content-Type must be application\/json/);

    const wrongType = await fetch(`${base}/factory/lanes`, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(laneInput("f3-text")),
    });
    expect(wrongType.status).toBe(400);
    expect(listLanes()).toHaveLength(0);

    const ok = await json(base, "POST", "/factory/lanes", laneInput("f3-json"));
    expect(ok.status).toBe(200);
    expect(listLanes()).toHaveLength(1);
  });

  it("register cannot spoof phase, fullSha, or agentSession", async () => {
    const spoof = await json(base, "POST", "/factory/lanes", {
      title: "spoof",
      ownerBotId: "impl",
      repo: "acme/widgets",
      branch: "feature/spoof",
      worktreePath: "C:\\work\\spoof",
      phase: "done",
      fullSha: SHA,
      agentSession: "session_evil",
    });
    expect(spoof.status).toBe(400);
    expect(spoof.body.error.message).toMatch(/unsupported fields/);

    const ok = await json(base, "POST", "/factory/lanes", {
      title: "ok",
      ownerBotId: "impl-ok",
      repo: "acme/widgets",
      branch: "feature/ok",
      worktreePath: "C:\\work\\ok",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.lane.phase).toBe("ready");
    expect(ok.body.lane.fullSha).toBeUndefined();
    expect(ok.body.lane.agentSession).toBeUndefined();
  });

  it("blocks frozen tip and protected session claims", async () => {
    const frozen = upsertLane(
      laneInput("frozen", { repo: VA.repo, branch: VA.branch, worktreePath: "C:\\fixture\\va-other", fullSha: VA_TIP }),
    );
    const protectedLane = upsertLane(
      laneInput("prot", {
        repo: "fixture/rr-ir",
        branch: "cos/rr-ir-review",
        worktreePath: "C:\\work\\prot",
        agentSession: "session_fixture_rr_ir",
      }),
    );

    const f = await json(base, "POST", "/factory/claim", {
      laneId: frozen.id,
      ownerBotId: frozen.ownerBotId,
      repo: frozen.repo,
      branch: frozen.branch,
      worktreePath: frozen.worktreePath,
    });
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe("ineligible");
    expect(f.body.error.message).toMatch(/frozen tip/i);

    const p = await json(base, "POST", "/factory/claim", {
      laneId: protectedLane.id,
      ownerBotId: protectedLane.ownerBotId,
      repo: protectedLane.repo,
      branch: protectedLane.branch,
      worktreePath: protectedLane.worktreePath,
    });
    expect(p.status).toBe(403);
    expect(p.body.error.code).toBe("ineligible");
  });

  it("claims eligible work, blocks duplicate ownership, waits and reports", async () => {
    upsertLane(laneInput("wait", { phase: "ci_wait", fullSha: SHA }));
    const ready = upsertLane(laneInput("ready", { fullSha: SHA }));
    const other = upsertLane(laneInput("other", { fullSha: "d".repeat(40) }));

    const claimed = await json(base, "POST", "/factory/claim", {});
    expect(claimed.status).toBe(200);
    expect(claimed.body.lane.id).toBe(ready.id);
    expect(claimed.body.lane.phase).toBe("running");

    const dup = await json(base, "POST", "/factory/claim", {
      laneId: other.id,
      ownerBotId: other.ownerBotId,
      repo: ready.repo,
      branch: ready.branch,
      worktreePath: ready.worktreePath,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("conflict");

    const moved = await json(base, "POST", `/factory/lanes/${ready.id}/transition`, {
      phase: "ci_wait",
      fullSha: SHA,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.lane.phase).toBe("ci_wait");

    const waited = await json(base, "POST", `/factory/lanes/${ready.id}/wait`, { timeoutMs: 100, pollMs: 20 });
    expect(waited.status).toBe(200);
    expect(waited.body.report.phase).toBe("ci_wait");
    expect(waited.body.report.finished).toBe(false);

    await json(base, "POST", `/factory/lanes/${ready.id}/transition`, { phase: "done", outcome: "KEEP_DRAFT" });
    const report = await json(base, "GET", `/factory/lanes/${ready.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.report).toMatchObject({ id: ready.id, phase: "done", finished: true, outcome: "KEEP_DRAFT" });
  });

  it("rejects invalid registration input", async () => {
    const bad = await json(base, "POST", "/factory/lanes", { title: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid");
  });

  it("recovers lane state after cache reset (restart)", async () => {
    const lane = upsertLane(laneInput("persist", { fullSha: SHA }));
    const claimed = await json(base, "POST", "/factory/claim", {
      laneId: lane.id,
      ownerBotId: lane.ownerBotId,
      repo: lane.repo,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
    });
    expect(claimed.status).toBe(200);
    transition(lane.id, "done", { outcome: "KEEP_DRAFT" });

    _resetFactoryLanes();
    expect(listLanes({ includeTerminal: true }).some((l) => l.id === lane.id && l.phase === "done")).toBe(true);

    const got = await json(base, "GET", `/factory/lanes/${lane.id}`);
    expect(got.status).toBe(200);
    expect(got.body.lane.phase).toBe("done");

    const waited = await json(base, "POST", `/factory/lanes/${lane.id}/wait`, {
      timeoutMs: 50,
      pollMs: 10,
      reload: true,
    });
    expect(waited.status).toBe(200);
    expect(waited.body.report.finished).toBe(true);
  });


  it("F1 register refuses existing id (no update)", async () => {
    const created = await json(base, "POST", "/factory/lanes", {
      id: "fixed-lane-id-f1",
      title: "first",
      ownerBotId: "impl-f1",
      repo: "acme/widgets",
      branch: "feature/f1",
      worktreePath: "C:\\work\\f1",
    });
    expect(created.status).toBe(200);
    expect(created.body.lane.id).toBe("fixed-lane-id-f1");
    expect(created.body.lane.title).toBe("first");

    const again = await json(base, "POST", "/factory/lanes", {
      id: "fixed-lane-id-f1",
      title: "second-should-fail",
      ownerBotId: "impl-f1",
      repo: "acme/widgets",
      branch: "feature/f1-moved",
      worktreePath: "C:\\work\\f1-moved",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
    expect(getLane("fixed-lane-id-f1")?.title).toBe("first");
    expect(getLane("fixed-lane-id-f1")?.branch).toBe("feature/f1");
  });

  it("F2 transition into ci_wait/qa_wait/owner_gate is protect-gated", async () => {
    const frozen = upsertLane(
      laneInput("f2-frozen", {
        repo: VA.repo,
        branch: VA.branch,
        worktreePath: "C:\\fixture\\f2-frozen-wt",
        fullSha: VA_TIP,
      }),
    );
    // Ready → ci_wait would take ownership + keep frozen SHA without F2 gate.
    const toCi = await json(base, "POST", `/factory/lanes/${frozen.id}/transition`, {
      phase: "ci_wait",
      fullSha: VA_TIP,
    });
    expect(toCi.status).toBe(403);
    expect(toCi.body.error.code).toBe("ineligible");
    expect(getLane(frozen.id)?.phase).toBe("ready");
    expect(getLane(frozen.id)?.claimedAt).toBeUndefined();

    const toQa = await json(base, "POST", `/factory/lanes/${frozen.id}/transition`, {
      phase: "qa_wait",
      reviewerBotId: "qa-bot-f2",
      fullSha: VA_TIP,
    });
    expect(toQa.status).toBe(403);
    expect(getLane(frozen.id)?.phase).toBe("ready");

    const toGate = await json(base, "POST", `/factory/lanes/${frozen.id}/transition`, {
      phase: "owner_gate",
      fullSha: VA_TIP,
    });
    expect(toGate.status).toBe(403);
    expect(getLane(frozen.id)?.phase).toBe("ready");

    // Disjoint lane can still enter ci_wait under protect ALLOW.
    const ok = upsertLane(laneInput("f2-ok", { fullSha: SHA }));
    const okCi = await json(base, "POST", `/factory/lanes/${ok.id}/transition`, {
      phase: "ci_wait",
      fullSha: SHA,
    });
    expect(okCi.status).toBe(200);
    expect(okCi.body.lane.phase).toBe("ci_wait");
  });

  it("F8 same-phase frozen patch is protect-gated", async () => {
    const lane = upsertLane(laneInput("f8", { fullSha: SHA }));
    const toCi = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase: "ci_wait", fullSha: SHA });
    expect(toCi.status).toBe(200);
    expect(toCi.body.lane.phase).toBe("ci_wait");

    const swap = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "ci_wait",
      fullSha: VA_TIP,
    });
    expect(swap.status).toBe(403);
    expect(swap.body.error.code).toBe("ineligible");
    expect(getLane(lane.id)?.phase).toBe("ci_wait");
    expect(getLane(lane.id)?.fullSha).toBe(SHA);
  });

  /** A lane that ran and is parked in qa_wait on SHA, reviewed by qa-bot. */
  function heldByQa(suffix: string) {
    const lane = upsertLane(laneInput(suffix, { reviewerBotId: "qa-bot" }));
    transition(lane.id, "running");
    return transition(lane.id, "qa_wait", { fullSha: SHA });
  }

  it("t1754u transition route will not resume or finish a qa_wait lane without a matching QA verdict", async () => {
    const lane = heldByQa("t1754u-held");
    const before = getLane(lane.id);
    const move = (phase: string, headers: Record<string, string> = {}) =>
      json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase }, headers);

    const unauthorized = await move("running", { authorization: "Bearer wrong-token" });
    expect(unauthorized.status).toBe(401);

    const pending = await move("running");
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe("ineligible");
    expect(pending.body.error.message).toBe(
      `lane ${lane.id} is held by QA in qa_wait (no QA verdict recorded); running needs QA FAIL`,
    );
    for (const phase of ["ready", "ci_wait", "owner_gate", "done", "failed", "cancelled"]) {
      const res = await move(phase);
      expect(res.status, phase).toBe(403);
      expect(res.body.error.code, phase).toBe("ineligible");
    }
    expect(getLane(lane.id)).toEqual(before);

    recordQaDisposition(lane.id, { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" });
    const passed = await move("running");
    expect(passed.status).toBe(403);
    expect(passed.body.error.message).toMatch(/\(QA PASS\); running needs QA FAIL$/);
    expect(getLane(lane.id)?.phase).toBe("qa_wait");

    const done = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase: "done", outcome: "KEEP_DRAFT" });
    expect(done.status).toBe(200);
    expect(done.body.lane).toMatchObject({ phase: "done", qaDisposition: "PASS", outcome: "KEEP_DRAFT" });
  });

  it("t1754u transition route accepts the QA FAIL rework handoff and logs it", async () => {
    const lane = heldByQa("t1754u-rework");
    recordQaDisposition(lane.id, { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md", note: "missing test" });

    const rework = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "running",
      nextAction: "fix the QA findings",
    });
    expect(rework.status).toBe(200);
    expect(rework.body.lane).toMatchObject({ phase: "running", nextAction: "fix the QA findings" });
    expect(rework.body.lane.evidence.slice(-2)).toEqual([
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST.md", note: expect.stringMatching(/QA FAIL by qa-bot/) }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);
  });

  it("t1755u F3 transition route cannot swap a held lane's reviewer; restating it is fine", async () => {
    const lane = heldByQa("t1755u-f3");
    const before = getLane(lane.id);
    const swap = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase: "qa_wait", reviewerBotId: "qa-bot-2" });
    expect(swap.status).toBe(403);
    expect(swap.body.error.code).toBe("ineligible");
    expect(swap.body.error.message).toMatch(/its reviewer qa-bot is frozen/);
    expect(getLane(lane.id)).toEqual(before);

    const restate = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "qa_wait",
      reviewerBotId: "qa-bot",
      nextAction: "await QA",
    });
    expect(restate.status).toBe(200);
    expect(restate.body.lane).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot", nextAction: "await QA" });
  });

  it("t1755u F1 QA route records the assigned reviewer's FAIL, refuses anyone else, and enables the rework handoff", async () => {
    const lane = heldByQa("t1755u-qa-fail");
    const before = getLane(lane.id);
    const qa = (body: unknown, headers: Record<string, string> = {}) => json(base, "POST", `/factory/lanes/${lane.id}/qa`, body, headers);
    const move = (body: Record<string, unknown>) => json(base, "POST", `/factory/lanes/${lane.id}/transition`, body);
    const fail = { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md", note: "missing test" };

    // QA pending: the handoff is still refused.
    const pending = await move({ phase: "running" });
    expect(pending.status).toBe(403);
    expect(pending.body.error.message).toMatch(/no QA verdict recorded/);

    expect((await qa(fail, { authorization: "Bearer wrong-token" })).status).toBe(401);
    for (const reviewerBotId of [lane.ownerBotId, "someone-else"]) {
      const res = await qa({ ...fail, reviewerBotId });
      expect(res.status, reviewerBotId).toBe(403);
      expect(res.body.error.code, reviewerBotId).toBe("qa_independence");
    }
    for (const [label, body] of [
      ["unknown disposition", { ...fail, disposition: "MAYBE" }],
      ["no ref", { reviewerBotId: "qa-bot", disposition: "FAIL" }],
      ["no reviewer", { disposition: "FAIL", ref: "_cos/QA_DIGEST.md" }],
      ["note not text", { ...fail, note: { why: "x" } }],
      ["extra field", { ...fail, phase: "running" }],
    ] as const) {
      const res = await qa(body);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe("invalid");
    }
    expect((await qa({ ...fail, phase: "running" })).body.error.message).toBe("unsupported fields: phase");
    const textPlain = await qa(JSON.stringify(fail), { "content-type": "text/plain" });
    expect(textPlain.status).toBe(400);
    expect(textPlain.body.error.message).toBe("Content-Type must be application/json");
    expect((await json(base, "POST", "/factory/lanes/nope-t1755u/qa", fail)).status).toBe(404);
    expect(getLane(lane.id)).toEqual(before);

    const recorded = await qa(fail);
    expect(recorded.status).toBe(200);
    expect(recorded.body.lane).toMatchObject({ id: lane.id, phase: "qa_wait", qaDisposition: "FAIL", reviewerBotId: "qa-bot" });
    expect(recorded.body.lane.evidence.at(-1)).toMatchObject({ kind: "qa", ref: "_cos/QA_DIGEST.md", note: "FAIL by qa-bot — missing test" });
    expect(getLane(lane.id)?.qaDisposition).toBe("FAIL");

    // The handoff cannot credit another reviewer with that FAIL.
    const swap = await move({ phase: "running", reviewerBotId: "qa-bot-2" });
    expect(swap.status).toBe(403);
    expect(swap.body.error.code).toBe("ineligible");
    expect(getLane(lane.id)?.phase).toBe("qa_wait");

    const rework = await move({ phase: "running", nextAction: "fix the QA findings" });
    expect(rework.status).toBe(200);
    expect(rework.body.lane).toMatchObject({ phase: "running", reviewerBotId: "qa-bot", nextAction: "fix the QA findings" });
    expect(rework.body.lane.evidence.slice(-2)).toEqual([
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST.md", note: "QA FAIL by qa-bot handed the lane back for rework" }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);
    expect(readFileSync(join(DATA_DIR, "bridge.log"), "utf8")).not.toContain(TOKEN);
  });

  it("t1755u F1 QA route fails closed without a protect SoT, and a PASS through it lets the lane finish", async () => {
    const lane = heldByQa("t1755u-qa-pass");
    const before = getLane(lane.id);
    const pass = { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" };
    const qa = () => json(base, "POST", `/factory/lanes/${lane.id}/qa`, pass);

    delete process.env.COS_FACTORY_PROTECT_DIR;
    const unset = await qa();
    const missing = join(DATA_DIR, "protect-t1755u-missing");
    mkdirSync(missing, { recursive: true });
    process.env.COS_FACTORY_PROTECT_DIR = missing;
    const unreadable = await qa();
    process.env.COS_FACTORY_PROTECT_DIR = FIXTURE;
    for (const res of [unset, unreadable]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toEqual({ code: "ineligible", message: "protect SoT unavailable, failing closed" });
    }
    expect(getLane(lane.id)).toEqual(before);

    const recorded = await qa();
    expect(recorded.status).toBe(200);
    expect(recorded.body.lane).toMatchObject({ phase: "qa_wait", qaDisposition: "PASS" });
    const back = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase: "running" });
    expect(back.status).toBe(403);
    expect(back.body.error.message).toMatch(/\(QA PASS\); running needs QA FAIL$/);
    const done = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, { phase: "done", outcome: "KEEP_DRAFT" });
    expect(done.status).toBe(200);
    expect(done.body.lane).toMatchObject({ phase: "done", qaDisposition: "PASS", outcome: "KEEP_DRAFT" });
  });

  it("t1756u F-3 QA route refuses a verdict on a finished lane and leaves the store byte-identical", async () => {
    const file = join(DATA_DIR, "factory-lanes.json");
    for (const [phase, recorded, late] of [
      ["done", "PASS", "FAIL"],
      ["failed", "FAIL", "PASS"],
      ["cancelled", "BLOCKED", "PASS"],
    ] as const) {
      const lane = heldByQa(`t1756u-f3-${phase}`);
      recordQaDisposition(lane.id, { reviewerBotId: "qa-bot", disposition: recorded, ref: "_cos/QA_DIGEST.md" });
      transition(lane.id, phase);
      const before = readFileSync(file, "utf8");
      const res = await json(base, "POST", `/factory/lanes/${lane.id}/qa`, { reviewerBotId: "qa-bot", disposition: late, ref: "_cos/LATE_QA.md" });
      expect(res.status, phase).toBe(400);
      expect(res.body.error, phase).toEqual({ code: "terminal", message: `lane ${lane.id} is ${phase}; terminal lanes do not change` });
      expect(readFileSync(file, "utf8"), phase).toBe(before);
      expect(getLane(lane.id), phase).toMatchObject({ phase, qaDisposition: recorded });
    }
  });

  it("t1756u F-1 after a restart, a held verdict stored without a reviewer releases nothing; the reviewer the route assigns must record a fresh one", async () => {
    const now = Date.now();
    const stored = {
      ...laneInput("t1756u-f1"),
      id: "t1756u-f1",
      phase: "qa_wait",
      fullSha: SHA,
      qaDisposition: "FAIL",
      evidence: [{ at: now, kind: "qa", ref: "_cos/QA_DIGEST.md", note: "FAIL" }],
      createdAt: now,
      updatedAt: now,
    };
    writeFileSync(join(DATA_DIR, "factory-lanes.json"), JSON.stringify({ version: 1, lanes: [stored] }));
    _resetFactoryLanes();
    const move = (body: Record<string, unknown>) => json(base, "POST", "/factory/lanes/t1756u-f1/transition", body);
    const qa = (body: Record<string, unknown>) => json(base, "POST", "/factory/lanes/t1756u-f1/qa", body);

    const loaded = await json(base, "GET", "/factory/lanes/t1756u-f1");
    expect(loaded.status).toBe(200);
    expect(loaded.body.lane.qaDisposition).toBeUndefined();
    const handoff = await move({ phase: "running", reviewerBotId: "qa-bot-2" });
    expect(handoff.status).toBe(403);
    expect(handoff.body.error.message).toMatch(/\(no QA verdict recorded\); running needs QA FAIL$/);

    // F-4: the route ignores a blank reviewer, so the hold stays assignable, and a blank records nothing.
    for (const reviewerBotId of ["", "   "]) {
      const blank = await move({ phase: "qa_wait", reviewerBotId });
      expect(blank.status).toBe(200);
      expect(blank.body.lane.reviewerBotId).toBeUndefined();
      const blankQa = await qa({ reviewerBotId, disposition: "FAIL", ref: "_cos/QA_DIGEST.md" });
      expect(blankQa.status).toBe(400);
      expect(blankQa.body.error.code).toBe("invalid");
    }

    const assigned = await move({ phase: "qa_wait", reviewerBotId: "qa-bot-2" });
    expect(assigned.status).toBe(200);
    expect(assigned.body.lane).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot-2" });
    expect(assigned.body.lane.qaDisposition).toBeUndefined();
    expect((await move({ phase: "running" })).status).toBe(403);

    expect((await qa({ reviewerBotId: "qa-bot-2", disposition: "FAIL", ref: "_cos/QA_DIGEST-2.md" })).status).toBe(200);
    const rework = await move({ phase: "running" });
    expect(rework.status).toBe(200);
    expect(rework.body.lane.evidence.slice(-2)).toEqual([
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST-2.md", note: "QA FAIL by qa-bot-2 handed the lane back for rework" }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);
  });

  it("t1757u R-1 after a restart, a held verdict without its reviewer's qa note releases nothing; the route's own verdict does", async () => {
    const now = Date.now();
    const held = (id: string, fields: Record<string, unknown>) => ({ ...laneInput(id), id, phase: "qa_wait", fullSha: SHA, createdAt: now, updatedAt: now, ...fields });
    const qaEntry = (ref: string, note: string) => ({ at: now, kind: "qa", ref, note });
    writeFileSync(
      join(DATA_DIR, "factory-lanes.json"),
      JSON.stringify({
        version: 1,
        lanes: [
          // An older tool's PASS: its note does not name the reviewer.
          held("r1-pass", { reviewerBotId: "qa-bot", qaDisposition: "PASS", evidence: [qaEntry("_cos/QA_DIGEST.md", "PASS — looks good")] }),
          // qa-bot-1's FAIL, after an older tool gave the hold to qa-bot-2.
          held("r1-swap", { reviewerBotId: "qa-bot-2", qaDisposition: "FAIL", evidence: [qaEntry("_cos/QA_DIGEST-1.md", "FAIL by qa-bot-1 — missing test")] }),
          // Control: a PASS its reviewer recorded.
          held("r1-ok", { reviewerBotId: "qa-bot", qaDisposition: "PASS", evidence: [qaEntry("_cos/QA_DIGEST.md", "PASS by qa-bot")] }),
        ],
      }),
    );
    _resetFactoryLanes();
    const move = (id: string, body: Record<string, unknown>) => json(base, "POST", `/factory/lanes/${id}/transition`, body);

    const done = await move("r1-pass", { phase: "done", outcome: "KEEP_DRAFT" });
    expect(done.status).toBe(403);
    expect(done.body.error).toEqual({ code: "ineligible", message: "lane r1-pass is held by QA in qa_wait (no QA verdict recorded); done needs QA PASS" });

    const rework = await move("r1-swap", { phase: "running" });
    expect(rework.status).toBe(403);
    expect(rework.body.error).toEqual({ code: "ineligible", message: "lane r1-swap is held by QA in qa_wait (no QA verdict recorded); running needs QA FAIL" });
    const swapped = await json(base, "GET", "/factory/lanes/r1-swap");
    expect(swapped.body.lane).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot-2" });
    expect(swapped.body.lane.qaDisposition).toBeUndefined();
    expect(swapped.body.lane.evidence.map((entry: { kind: string }) => entry.kind)).toEqual(["qa"]);

    const ok = await move("r1-ok", { phase: "done", outcome: "KEEP_DRAFT" });
    expect(ok.status).toBe(200);
    expect(ok.body.lane).toMatchObject({ phase: "done", qaDisposition: "PASS" });

    // qa-bot-2's own FAIL through the route is the handoff, credited to them with their ref.
    const recorded = await json(base, "POST", "/factory/lanes/r1-swap/qa", { reviewerBotId: "qa-bot-2", disposition: "FAIL", ref: "_cos/QA_DIGEST-2.md" });
    expect(recorded.status).toBe(200);
    const handed = await move("r1-swap", { phase: "running" });
    expect(handed.status).toBe(200);
    expect(handed.body.lane.evidence.slice(-2)).toEqual([
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST-2.md", note: "QA FAIL by qa-bot-2 handed the lane back for rework" }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);
  });

  it("t1758u the QA route records who recorded the verdict; after a restart one recorded by anyone else releases nothing", async () => {
    const lane = heldByQa("t1758u-recorder");
    const recorded = await json(base, "POST", `/factory/lanes/${lane.id}/qa`, { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" });
    expect(recorded.status).toBe(200);
    expect(recorded.body.lane).toMatchObject({ phase: "qa_wait", qaDisposition: "PASS", qaRecordedBy: "qa-bot" });

    const now = Date.now();
    const held = (id: string, fields: Record<string, unknown>) => ({
      ...laneInput(id),
      id,
      phase: "qa_wait",
      fullSha: SHA,
      reviewerBotId: "qa-bot",
      qaDisposition: "PASS",
      evidence: [{ at: now, kind: "qa", ref: "_cos/QA_DIGEST.md", note: "PASS by qa-bot" }],
      createdAt: now,
      updatedAt: now,
      ...fields,
    });
    writeFileSync(
      join(DATA_DIR, "factory-lanes.json"),
      JSON.stringify({
        version: 1,
        lanes: [
          // The note names the reviewer, but the recorder on file is someone else.
          held("c-other", { qaRecordedBy: "qa-bot-2" }),
          // Stored before the field existed: the note alone attributes it.
          held("c-legacy", {}),
        ],
      }),
    );
    _resetFactoryLanes();
    const finish = (id: string) => json(base, "POST", `/factory/lanes/${id}/transition`, { phase: "done", outcome: "KEEP_DRAFT" });

    const other = await finish("c-other");
    expect(other.status).toBe(403);
    expect(other.body.error).toEqual({ code: "ineligible", message: "lane c-other is held by QA in qa_wait (no QA verdict recorded); done needs QA PASS" });
    const legacy = await finish("c-legacy");
    expect(legacy.status).toBe(200);
    expect(legacy.body.lane).toMatchObject({ phase: "done", qaDisposition: "PASS" });
    expect(legacy.body.lane.qaRecordedBy).toBeUndefined();
  });

  it("t1758u I-3 refuses a reviewer id that does not print on every route that takes one, and writes nothing", async () => {
    const held = heldByQa("t1758u-i3-held");
    const ready = upsertLane(laneInput("t1758u-i3-ready"));
    const file = join(DATA_DIR, "factory-lanes.json");
    const before = readFileSync(file, "utf8");
    for (const reviewerBotId of ["​", "qa-bot​", "qa⁠bot"]) {
      const label = JSON.stringify(reviewerBotId);
      for (const res of [
        await json(base, "POST", "/factory/lanes", { ...laneInput("t1758u-i3-new"), reviewerBotId }),
        await json(base, "POST", `/factory/lanes/${ready.id}/transition`, { phase: "ready", reviewerBotId }),
        await json(base, "POST", `/factory/lanes/${held.id}/transition`, { phase: "qa_wait", reviewerBotId }),
        await json(base, "POST", `/factory/lanes/${held.id}/qa`, { reviewerBotId, disposition: "FAIL", ref: "_cos/QA_DIGEST.md" }),
      ]) {
        expect(res.status, label).toBe(400);
        expect(res.body.error.code, label).toBe("invalid");
      }
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects bad Origin for non-health requests", async () => {
    const res = await json(base, "GET", "/factory/lanes", undefined, { origin: "https://evil.example" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Origin/);
  });

  it("F5 bad protect SoT replies fail closed without leaking paths", async () => {
    const PATHISH = /[A-Za-z]:\\|\/Users\/|\/home\//;
    const missing = join(DATA_DIR, "protect-f5-missing");
    mkdirSync(missing, { recursive: true });
    process.env.COS_FACTORY_PROTECT_DIR = missing;

    const reg = await json(base, "POST", "/factory/lanes", laneInput("f5-reg"));
    const claim = await json(base, "POST", "/factory/claim", {});
    for (const res of [reg, claim]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ineligible");
      expect(res.body.error.message).toBe("protect SoT unavailable, failing closed");
      expect(res.body.error.message).not.toMatch(PATHISH);
      expect(res.body.error.message).not.toContain(missing);
    }
    expect(listLanes()).toHaveLength(0);

    // Full detail stays server-side.
    const logged = readFileSync(join(DATA_DIR, "bridge.log"), "utf8");
    expect(logged).toContain(missing);
  });

  it("F5 authorized errors keep useful non-path messages", async () => {
    const unsupported = await json(base, "POST", "/factory/claim", { protectDir: "C:\\evil\\protect" });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.message).toBe("unsupported fields: protectDir");

    const noType = await json(base, "POST", "/factory/lanes", JSON.stringify(laneInput("f5-type")), {
      "content-type": "text/plain",
    });
    expect(noType.status).toBe(400);
    expect(noType.body.error.message).toBe("Content-Type must be application/json");

    const missingLane = await json(base, "GET", "/factory/lanes/nope-f5");
    expect(missingLane.status).toBe(404);
    expect(missingLane.body.error.message).toBe("no factory lane nope-f5");
  });

  it("F5 clientErrorMessage redacts absolute paths", () => {
    const msg = (text: string) => clientErrorMessage(new FactoryLaneError("invalid", text));
    expect(msg("protect SoT unavailable, failing closed: cannot read C:\\cos\\protect\\x.json")).toBe(
      "protect SoT unavailable, failing closed",
    );
    expect(msg("worktree C:\\work\\wt-a overlaps D:/other/wt")).toBe("worktree <path> overlaps <path>");
    expect(msg("worktree /home/me/wt overlaps /Users/me/wt and \\\\srv\\share\\wt")).toBe(
      "worktree <path> overlaps <path> and <path>",
    );
    expect(msg(`dir ${FIXTURE} bad`)).not.toContain(FIXTURE);
    expect(msg("lane acme/widgets in ci_wait/qa_wait; Content-Type must be application/json")).toBe(
      "lane acme/widgets in ci_wait/qa_wait; Content-Type must be application/json",
    );
  });

  it("F4 register rejects non-string pathClaims instead of coercing", async () => {
    const reg = (suffix: string, pathClaims: unknown) =>
      json(base, "POST", "/factory/lanes", { ...laneInput(`f4-${suffix}`), id: `f4-${suffix}`, pathClaims });

    for (const [suffix, claims] of [
      ["obj", [{}]],
      ["null", [null]],
      ["kv", [{ a: 1 }]],
      ["num", [1]],
      ["empty", ["  "]],
      ["mixed", ["src/a.ts", {}]],
      ["str", "foo"],
      ["bare", {}],
    ] as const) {
      const res = await reg(suffix, claims);
      expect(res.status, suffix).toBe(400);
      expect(res.body.error.code).toBe("invalid");
      expect(res.body.error.message).toMatch(/^pathClaims must be an array of/);
      expect(getLane(`f4-${suffix}`)).toBeNull();
    }
    expect(listLanes({ includeTerminal: true })).toHaveLength(0);

    const ok = await reg("ok", ["src/a.ts", "src/b.ts"]);
    expect(ok.status).toBe(200);
    expect(ok.body.lane.pathClaims).toEqual(["src/a.ts", "src/b.ts"]);
    expect(getLane("f4-ok")?.pathClaims).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("F4 claim pathClaims and transition changedFiles reject object entries", async () => {
    const lane = upsertLane(laneInput("f4-claim", { fullSha: SHA }));
    const claimBody = {
      laneId: lane.id,
      ownerBotId: lane.ownerBotId,
      repo: lane.repo,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
    };
    const badClaim = await json(base, "POST", "/factory/claim", { ...claimBody, pathClaims: [{ a: 1 }] });
    expect(badClaim.status).toBe(400);
    expect(badClaim.body.error.message).toMatch(/^pathClaims must be an array of/);
    expect(getLane(lane.id)?.phase).toBe("ready");

    const notArray = await json(base, "POST", "/factory/claim", { pathClaims: "src/a.ts" });
    expect(notArray.status).toBe(400);
    expect(getLane(lane.id)?.phase).toBe("ready");

    const claimed = await json(base, "POST", "/factory/claim", { ...claimBody, pathClaims: ["src/c.ts"] });
    expect(claimed.status).toBe(200);
    expect(claimed.body.lane.pathClaims).toEqual(["src/c.ts"]);

    const badMove = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "running",
      changedFiles: ["src/c.ts", { a: 1 }],
    });
    expect(badMove.status).toBe(400);
    expect(badMove.body.error.message).toMatch(/^changedFiles must be an array of/);
    expect(getLane(lane.id)?.changedFiles).toBeUndefined();

    const badShape = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "running",
      changedFiles: { "src/c.ts": true },
    });
    expect(badShape.status).toBe(400);

    const moved = await json(base, "POST", `/factory/lanes/${lane.id}/transition`, {
      phase: "running",
      changedFiles: ["src/c.ts"],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.lane.changedFiles).toEqual(["src/c.ts"]);
  });
});

describe("factory bridge startup status (t1750u F7)", () => {
  const PATH = "C:\\secret\\place";

  it("reports protectDir from COS_FACTORY_PROTECT_DIR, COS_FACTORY_ROOT, or unset — never the path", () => {
    const direct = formatProtectDirStatus({ COS_FACTORY_PROTECT_DIR: PATH, COS_FACTORY_ROOT: "C:\\root" });
    expect(direct).toBe("configured (COS_FACTORY_PROTECT_DIR)");
    const root = formatProtectDirStatus({ COS_FACTORY_ROOT: PATH });
    expect(root).toBe("configured (COS_FACTORY_ROOT)");
    expect(formatProtectDirStatus({ COS_FACTORY_PROTECT_DIR: "  ", COS_FACTORY_ROOT: PATH })).toBe(
      "configured (COS_FACTORY_ROOT)",
    );
    expect(formatProtectDirStatus({})).toBe("unset — mutating ops fail closed");
    expect(formatProtectDirStatus({ COS_FACTORY_PROTECT_DIR: " ", COS_FACTORY_ROOT: "" })).toBe(
      "unset — mutating ops fail closed",
    );
    for (const s of [direct, root]) expect(s).not.toContain("secret");
  });

  it("reports dataDir as configured or default without the path", () => {
    const configured = formatDataDirStatus({ OMB_DATA_DIR: PATH });
    expect(configured).toBe("configured (OMB_DATA_DIR)");
    expect(configured).not.toContain("secret");
    expect(formatDataDirStatus({})).toBe("default (~/.openmausbot)");
  });
});
