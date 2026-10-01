/**
 * Focused factory bridge HTTP tests (t1742u).
 * Covers: frozen tips, protected sessions, duplicate claims, invalid input,
 * restart recovery (reload), unauthorized ops. Loopback only.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { listenFactoryBridge } from "./factory-bridge-http.ts";
import {
  listLanes,
  transition,
  upsertLane,
  _resetFactoryLanes,
} from "./factory-lanes.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t1734u-protect");
const VA = { repo: "Bthornton1994/Virtual-Assistant", branch: "cos/rr-d1d4-operator-only-19d4f99e" };
const VA_TIP = "ca813c0dd29e5c38063efa571d809b0dbd5a4bfb";
const SHA = "c".repeat(40);

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
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

describe("factory bridge HTTP (t1742u)", () => {
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
    const { server, url } = await listenFactoryBridge({
      port: 0 as unknown as number, // overridden below via listen(0)
      accessLogPath: join(DATA_DIR, "bridge.log"),
    });
    // listenFactoryBridge with port 0: our impl uses Number â€” fix by re-listen pattern
    // Actually createServer listen(0) â€” update: we passed port 0 which is fine for ephemeral.
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP address");
    base = `http://127.0.0.1:${addr.port}`;
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    void url;
  });

  afterEach(async () => {
    await close();
    delete process.env.COS_FACTORY_PROTECT_DIR;
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

    transition(ready.id, "ci_wait");
    const waited = await json(base, "POST", `/factory/lanes/${ready.id}/wait`, { timeoutMs: 100, pollMs: 20 });
    expect(waited.status).toBe(200);
    expect(waited.body.report.phase).toBe("ci_wait");
    expect(waited.body.report.finished).toBe(false);

    transition(ready.id, "done", { outcome: "KEEP_DRAFT" });
    const report = await json(base, "GET", `/factory/lanes/${ready.id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.report).toMatchObject({ id: ready.id, phase: "done", finished: true, outcome: "KEEP_DRAFT" });
  });

  it("rejects invalid task input", async () => {
    const bad = await json(base, "POST", "/factory/lanes", { title: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid");

    const badJson = await fetch(`${base}/factory/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
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
});