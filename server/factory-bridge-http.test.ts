/**
 * Focused factory bridge HTTP tests (t1742u + t1743u harden).
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { listenFactoryBridge, FACTORY_BRIDGE_MAX_BODY_BYTES } from "./factory-bridge-http.ts";
import {
  listLanes,
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

  it("rejects bad Origin for non-health requests", async () => {
    const res = await json(base, "GET", "/factory/lanes", undefined, { origin: "https://evil.example" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Origin/);
  });
});