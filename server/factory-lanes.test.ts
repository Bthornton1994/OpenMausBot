// Factory lanes — durable store + manager-loop dispatch. DATA_DIR is the
// per-file throwaway home from server/testing/setup.ts; each test starts from
// an empty factory-lanes.json and a cold in-memory cache.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  appendEvidence,
  claimNextEligible,
  claimWorktree,
  FactoryLaneError,
  getLane,
  laneOwnershipKey,
  listLanes,
  ownershipOverlap,
  recordQaDisposition,
  releaseOwnership,
  transition,
  upsertLane,
  waitLane,
  _loadFactoryLanes,
  _resetFactoryLanes,
  type FactoryLane,
  type FactoryLaneErrorCode,
} from "./factory-lanes.ts";

const FILE = join(DATA_DIR, "factory-lanes.json");
const SHA_A = "a".repeat(40);

function expectLaneError(fn: () => unknown, code: FactoryLaneErrorCode, message?: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryLaneError);
    expect((error as FactoryLaneError).code).toBe(code);
    if (message) expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error(`expected FactoryLaneError(${code})`);
}

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

/** An implementer lane that ran and is now parked in qa_wait on SHA_A,
 * reviewed by qa-bot. */
function heldByQa(suffix: string): FactoryLane {
  const lane = upsertLane(laneInput(suffix, { reviewerBotId: "qa-bot" }));
  transition(lane.id, "running");
  return transition(lane.id, "qa_wait", { fullSha: SHA_A });
}

const verdict = (id: string, disposition: Parameters<typeof recordQaDisposition>[1]["disposition"], ref = "_cos/QA_DIGEST.md") =>
  recordQaDisposition(id, { reviewerBotId: "qa-bot", disposition, ref });

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of readdirSync(DATA_DIR)) {
    if (name.startsWith("factory-lanes.json")) rmSync(join(DATA_DIR, name), { force: true });
  }
  _resetFactoryLanes();
});

describe("factory lanes: manager loop", () => {
  it("dispatches a disjoint ready lane while another waits on QA, never a second writer on the frozen tip", () => {
    // 1. Lane A: claimed, running, then parked in qa_wait on worktree A / branch A.
    const a = upsertLane(laneInput("a", { reviewerBotId: "qa-bot" }));
    claimWorktree({ laneId: a.id, ownerBotId: a.ownerBotId, repo: a.repo, branch: a.branch, worktreePath: a.worktreePath });
    transition(a.id, "running");
    appendEvidence(a.id, { kind: "commit", ref: SHA_A, note: "tip for QA" });
    const aWaiting = transition(a.id, "qa_wait", { fullSha: SHA_A, nextAction: "independent QA of tip" });
    expect(aWaiting.phase).toBe("qa_wait");
    expect(aWaiting.claimedAt).toBeTypeOf("number");

    // 2. Lane B: ready on a different worktree and branch.
    const b = upsertLane(laneInput("b"));
    expect(b.phase).toBe("ready");

    // 3. The manager loop picks B, moves it to running, and B holds ownership.
    const claimed = claimNextEligible();
    expect(claimed?.id).toBe(b.id);
    expect(claimed?.phase).toBe("running");
    expect(claimed?.claimedAt).toBeTypeOf("number");
    expect(claimed?.evidence.some((entry) => entry.kind === "claim" && entry.note?.includes(`${a.id}:qa_wait`))).toBe(true);

    // 4. Anything overlapping A's frozen branch or worktree is refused.
    const c = upsertLane(laneInput("c", { branch: a.branch, worktreePath: "C:\\work\\wt-c" }));
    const d = upsertLane(laneInput("d", { worktreePath: "c:/work/WT-A/" })); // same folder, different spelling
    expect(claimNextEligible()).toBeNull();
    expectLaneError(() => claimWorktree({ laneId: c.id, ownerBotId: c.ownerBotId, repo: c.repo, branch: c.branch, worktreePath: c.worktreePath }), "conflict");
    expectLaneError(() => claimWorktree({ laneId: d.id, ownerBotId: d.ownerBotId, repo: d.repo, branch: d.branch, worktreePath: d.worktreePath }), "conflict");
    expectLaneError(() => transition(c.id, "running"), "conflict");
    expectLaneError(() => transition(d.id, "running"), "conflict");
    // Nor can someone else grab B's fresh claim.
    const e = upsertLane(laneInput("e", { branch: b.branch, worktreePath: "C:\\work\\wt-e" }));
    expectLaneError(() => transition(e.id, "running"), "conflict");
    expect(listLanes({ phase: "running" }).map((lane) => lane.id)).toEqual([b.id]);

    // 5. Both lanes keep accurate state and evidence — also after a reload from disk.
    _resetFactoryLanes();
    const aAfter = getLane(a.id)!;
    const bAfter = getLane(b.id)!;
    expect(aAfter.phase).toBe("qa_wait");
    expect(aAfter.fullSha).toBe(SHA_A);
    expect(aAfter.evidence.map((entry) => entry.kind)).toEqual(["claim", "phase", "commit", "phase"]);
    expect(bAfter.phase).toBe("running");
    expect(bAfter.evidence.map((entry) => entry.kind)).toEqual(["claim", "phase"]);
    expect(getLane(c.id)!.phase).toBe("ready");
    expect(getLane(d.id)!.phase).toBe("ready");

    // 6. QA stays independent of the implementer.
    expectLaneError(() => upsertLane(laneInput("f", { reviewerBotId: "implementer-f" })), "qa_independence");
    expectLaneError(() => transition(b.id, "qa_wait", { reviewerBotId: b.ownerBotId }), "qa_independence");
    expectLaneError(
      () => recordQaDisposition(a.id, { reviewerBotId: a.ownerBotId, disposition: "PASS", ref: "DIGEST.md" }),
      "qa_independence",
    );
    expectLaneError(
      () => recordQaDisposition(a.id, { reviewerBotId: "someone-else", disposition: "PASS", ref: "DIGEST.md" }),
      "qa_independence",
    );
    const reviewed = recordQaDisposition(a.id, { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" });
    expect(reviewed.qaDisposition).toBe("PASS");
    expect(reviewed.evidence.at(-1)).toMatchObject({ kind: "qa", ref: "_cos/QA_DIGEST.md", note: "PASS" });
  });

  it("does not dispatch when nothing is waiting unless forced", () => {
    const ready = upsertLane(laneInput("a"));
    expect(claimNextEligible()).toBeNull();
    expect(getLane(ready.id)!.phase).toBe("ready");
    expect(claimNextEligible({ forceParallel: true })?.id).toBe(ready.id);
  });

  it("prefers the requested owner, then the oldest lane, and skips blocked lanes", () => {
    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const blocked = upsertLane(laneInput("blocked", { blocker: "owner decision pending" }));
    const oldest = upsertLane(laneInput("old"));
    const preferred = upsertLane(laneInput("pref", { ownerBotId: "implementer-x" }));
    expect(claimNextEligible({ preferOwnerBotId: "implementer-x" })?.id).toBe(preferred.id);
    expect(claimNextEligible()?.id).toBe(oldest.id);
    expect(claimNextEligible()).toBeNull();
    expect(getLane(blocked.id)!.phase).toBe("ready");
  });

  it("treats owner_gate as frozen", () => {
    const gated = upsertLane(laneInput("gate", { phase: "owner_gate" }));
    upsertLane(laneInput("wait", { phase: "qa_wait" }));
    upsertLane(laneInput("same", { branch: gated.branch, worktreePath: "C:\\work\\other" }));
    expect(claimNextEligible()).toBeNull();
  });
});

describe("factory lanes: ownership", () => {
  it("overlaps on same repo+branch, nested worktrees, and shared path claims", () => {
    const base = { repo: "acme/widgets", branch: "main", worktreePath: "/w/a", pathClaims: ["src/lib"] };
    expect(ownershipOverlap(base, { ...base, worktreePath: "/w/b", pathClaims: [] })).toMatch(/branch/);
    expect(ownershipOverlap(base, { ...base, branch: "x", worktreePath: "/w/a/sub", pathClaims: [] })).toMatch(/worktree/);
    expect(ownershipOverlap(base, { ...base, branch: "x", worktreePath: "/w/b", pathClaims: ["src/lib/util.ts"] })).toMatch(/path/);
    expect(ownershipOverlap(base, { ...base, branch: "x", worktreePath: "/w/ab", pathClaims: ["src/libx"] })).toBeNull();
    expect(ownershipOverlap(base, { repo: "acme/other", branch: "main", worktreePath: "/w/c", pathClaims: ["src/lib"] })).toBeNull();
  });

  it("derives a normalized ownership key", () => {
    expect(laneOwnershipKey({ repo: "Acme/Widgets", branch: "Feat/X", worktreePath: "C:\\Work\\WT\\" })).toBe("acme/widgets#feat/x#c:/work/wt");
  });

  it("is exclusive until released, and only for the lane's owner", () => {
    const a = upsertLane(laneInput("a"));
    const b = upsertLane(laneInput("b", { branch: a.branch, worktreePath: "C:\\work\\wt-b2" }));
    claimWorktree({ laneId: a.id, ownerBotId: a.ownerBotId, repo: a.repo, branch: a.branch, worktreePath: a.worktreePath });
    // idempotent re-claim by the same lane
    claimWorktree({ laneId: a.id, ownerBotId: a.ownerBotId, repo: a.repo, branch: a.branch, worktreePath: a.worktreePath });
    expect(getLane(a.id)!.evidence.filter((entry) => entry.kind === "claim")).toHaveLength(1);
    expectLaneError(() => claimWorktree({ laneId: b.id, ownerBotId: b.ownerBotId, repo: b.repo, branch: b.branch, worktreePath: b.worktreePath }), "conflict");
    expectLaneError(() => claimWorktree({ laneId: a.id, ownerBotId: "intruder", repo: a.repo, branch: a.branch, worktreePath: a.worktreePath }), "conflict");
    releaseOwnership(a.id);
    expect(claimWorktree({ laneId: b.id, ownerBotId: b.ownerBotId, repo: b.repo, branch: b.branch, worktreePath: b.worktreePath }).claimedAt).toBeTypeOf("number");
  });

  it("keeps a frozen lane blocking after its explicit claim is released", () => {
    const a = upsertLane(laneInput("a"));
    transition(a.id, "running");
    transition(a.id, "ci_wait");
    releaseOwnership(a.id);
    const b = upsertLane(laneInput("b", { branch: a.branch, worktreePath: "C:\\work\\wt-b2" }));
    expectLaneError(() => transition(b.id, "running"), "conflict");
  });

  it("refuses to move a claimed lane's worktree through upsert", () => {
    const a = upsertLane(laneInput("a", { pathClaims: ["src"] }));
    transition(a.id, "running");
    expect(upsertLane({ ...laneInput("a"), id: a.id, nextAction: "keep going" }).pathClaims).toEqual(["src"]);
    expectLaneError(() => upsertLane({ ...laneInput("a", { branch: "feature/other" }), id: a.id }), "conflict");
  });

  it("releases ownership when a lane finishes", () => {
    const a = upsertLane(laneInput("a"));
    transition(a.id, "running");
    transition(a.id, "done", { outcome: "merged", prUrl: "https://example.test/pr/1" });
    const b = upsertLane(laneInput("b", { branch: a.branch, worktreePath: a.worktreePath }));
    expect(transition(b.id, "running").phase).toBe("running");
  });
});

describe("factory lanes: QA hold (t1754u)", () => {
  it("refuses to resume implementation while QA is pending, and writes nothing", () => {
    const lane = heldByQa("a");
    const before = getLane(lane.id)!;
    for (const phase of ["running", "ready"] as const) {
      expectLaneError(() => transition(lane.id, phase), "ineligible", new RegExp(`held by QA in qa_wait \\(no QA verdict recorded\\); ${phase} needs QA FAIL`));
    }
    expect(getLane(lane.id)).toEqual(before);
    // Annotating the held lane in place is still fine.
    expect(transition(lane.id, "qa_wait", { blocker: "QA seat busy" })).toMatchObject({ phase: "qa_wait", blocker: "QA seat busy" });
  });

  it("does not let PASS, BLOCKED, NOT RUN or UNKNOWN hand a lane back for rework", () => {
    const lane = heldByQa("a");
    for (const disposition of ["PASS", "BLOCKED", "NOT RUN", "UNKNOWN"] as const) {
      verdict(lane.id, disposition);
      for (const phase of ["running", "ready"] as const) {
        expectLaneError(() => transition(lane.id, phase), "ineligible", new RegExp(`\\(QA ${disposition}\\); ${phase} needs QA FAIL`));
      }
    }
    expect(getLane(lane.id)!.phase).toBe("qa_wait");
  });

  it("hands a lane back for rework on its reviewer's recorded FAIL, and logs the handoff", () => {
    const lane = heldByQa("a");
    verdict(lane.id, "FAIL", "_cos/QA_DIGEST.md");
    const rework = transition(lane.id, "running", { nextAction: "fix the QA findings" });
    expect(rework).toMatchObject({ phase: "running", qaDisposition: "FAIL", claimedAt: lane.claimedAt });
    expect(rework.evidence.slice(-2)).toEqual([
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST.md", note: expect.stringMatching(/QA FAIL by qa-bot/) }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);

    // The next QA round starts without a verdict: the old FAIL does not carry over.
    const again = transition(lane.id, "qa_wait", { fullSha: "b".repeat(40) });
    expect(again.qaDisposition).toBeUndefined();
    expectLaneError(() => transition(lane.id, "running"), "ineligible", /no QA verdict recorded/);

    // ready is the same handoff, queued for the manager loop.
    verdict(lane.id, "FAIL");
    const queued = transition(lane.id, "ready");
    expect(queued.phase).toBe("ready");
    expect(queued.evidence.at(-2)).toMatchObject({ kind: "rework" });
  });

  it("does not carry a verdict recorded outside qa_wait into the hold", () => {
    const lane = upsertLane(laneInput("a", { reviewerBotId: "qa-bot" }));
    transition(lane.id, "running");
    verdict(lane.id, "FAIL", "early.md");
    expect(transition(lane.id, "qa_wait", { fullSha: SHA_A }).qaDisposition).toBeUndefined();
    expectLaneError(() => transition(lane.id, "running"), "ineligible", /no QA verdict recorded/);
  });

  it("lets a held lane finish only on a verdict that fits the outcome", () => {
    const pending = heldByQa("pending");
    for (const phase of ["done", "failed", "cancelled"] as const) {
      expectLaneError(() => transition(pending.id, phase), "ineligible", /no QA verdict recorded/);
    }

    const passed = heldByQa("pass");
    verdict(passed.id, "PASS");
    expectLaneError(() => transition(passed.id, "failed"), "ineligible", /failed needs QA FAIL/);
    expect(transition(passed.id, "done", { outcome: "KEEP_DRAFT" })).toMatchObject({ phase: "done", qaDisposition: "PASS" });

    const failed = heldByQa("fail");
    verdict(failed.id, "FAIL");
    expectLaneError(() => transition(failed.id, "done"), "ineligible", /done needs QA PASS/);
    expect(transition(failed.id, "failed").phase).toBe("failed");

    const blocked = heldByQa("blocked");
    verdict(blocked.id, "BLOCKED");
    expectLaneError(() => transition(blocked.id, "done"), "ineligible", /done needs QA PASS/);
    expectLaneError(() => transition(blocked.id, "failed"), "ineligible", /failed needs QA FAIL/);
    expect(transition(blocked.id, "cancelled").phase).toBe("cancelled");

    // Finishing still releases the tip, as for any lane.
    const next = upsertLane(laneInput("next", { branch: passed.branch, worktreePath: passed.worktreePath }));
    expect(transition(next.id, "running").phase).toBe("running");
  });

  it("never parks a held lane in ci_wait or owner_gate, whatever the verdict", () => {
    const lane = heldByQa("a");
    for (const disposition of [undefined, "PASS", "FAIL", "BLOCKED"] as const) {
      if (disposition) verdict(lane.id, disposition);
      for (const phase of ["ci_wait", "owner_gate"] as const) {
        expectLaneError(() => transition(lane.id, phase), "ineligible", new RegExp(`${phase} is not an exit from qa_wait`));
      }
    }
    expect(getLane(lane.id)!.phase).toBe("qa_wait");
  });

  it("keeps a held lane's claim until QA records a verdict", () => {
    const lane = heldByQa("a");
    expectLaneError(() => releaseOwnership(lane.id), "ineligible", /no QA verdict recorded/);
    expect(getLane(lane.id)!.claimedAt).toBe(lane.claimedAt);

    verdict(lane.id, "BLOCKED");
    expect(releaseOwnership(lane.id).claimedAt).toBeUndefined();
    // Released or not, the phase keeps the frozen tip blocked.
    const rival = upsertLane(laneInput("rival", { branch: lane.branch, worktreePath: "C:\\work\\wt-rival" }));
    expectLaneError(() => transition(rival.id, "running"), "conflict");
  });

  it("freezes the tip QA is judging", () => {
    const lane = heldByQa("a");
    const other = "b".repeat(40);
    expectLaneError(() => transition(lane.id, "qa_wait", { fullSha: other }), "ineligible", /tip is frozen/);
    expectLaneError(() => upsertLane({ ...laneInput("a", { reviewerBotId: "qa-bot" }), id: lane.id, fullSha: other }), "ineligible", /tip is frozen/);
    verdict(lane.id, "PASS");
    expectLaneError(() => transition(lane.id, "done", { fullSha: other }), "ineligible", /tip is frozen/);
    expect(getLane(lane.id)!.fullSha).toBe(SHA_A);
    // Restating the same tip (any case) is not a change.
    expect(transition(lane.id, "done", { fullSha: SHA_A.toUpperCase(), outcome: "KEEP_DRAFT" })).toMatchObject({ phase: "done", fullSha: SHA_A });
  });
});

describe("factory lanes: lifecycle and persistence", () => {
  it("refuses transitions out of terminal phases but still accepts late evidence", () => {
    for (const terminal of ["done", "failed", "cancelled"] as const) {
      const lane = upsertLane(laneInput(terminal));
      transition(lane.id, terminal);
      expectLaneError(() => transition(lane.id, "ready"), "terminal");
      expectLaneError(() => upsertLane({ ...laneInput(terminal), id: lane.id, title: "renamed" }), "terminal");
      expect(appendEvidence(lane.id, { kind: "ci", ref: "run-1" }).evidence.at(-1)?.kind).toBe("ci");
    }
  });

  it("rejects new lanes that start running or terminal, bad SHAs, and missing lanes", () => {
    expectLaneError(() => upsertLane(laneInput("a", { phase: "running" })), "invalid");
    expectLaneError(() => upsertLane(laneInput("a", { phase: "done" })), "invalid");
    expectLaneError(() => upsertLane(laneInput("a", { fullSha: "abc123" })), "invalid");
    expectLaneError(() => transition("missing", "running"), "not_found");
    expectLaneError(() => appendEvidence("missing", { kind: "x", ref: "y" }), "not_found");
    expect(listLanes()).toEqual([]);
  });

  it("persists atomically with private permissions and reloads", () => {
    const a = upsertLane(laneInput("a", { agentSession: "session_123" }));
    expect(existsSync(FILE)).toBe(true);
    if (process.platform !== "win32") expect(statSync(FILE).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.lanes[0].id).toBe(a.id);
    _loadFactoryLanes();
    expect(getLane(a.id)).toMatchObject({ agentSession: "session_123", phase: "ready" });
    expect(readdirSync(DATA_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("loads a corrupt file as empty and keeps a copy of it", () => {
    writeFileSync(FILE, "{not json");
    expect(listLanes()).toEqual([]);
    const backups = readdirSync(DATA_DIR).filter((name) => name.startsWith("factory-lanes.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, backups[0]!), "utf8")).toBe("{not json");
  });

  it("drops invalid stored lanes and a self-reviewer on load", () => {
    const now = Date.now();
    const good = { ...laneInput("a"), id: "a", phase: "qa_wait", evidence: [], reviewerBotId: "implementer-a", createdAt: now, updatedAt: now };
    writeFileSync(FILE, JSON.stringify({ version: 1, lanes: [good, { id: "bad" }, { ...good, phase: "nope", id: "b" }] }));
    const loaded = listLanes();
    expect(loaded.map((lane) => lane.id)).toEqual(["a"]);
    expect(loaded[0]!.reviewerBotId).toBeUndefined();
  });

  it("filters lanes", () => {
    const a = upsertLane(laneInput("a"));
    upsertLane(laneInput("b", { repo: "acme/other" }));
    transition(a.id, "cancelled");
    expect(listLanes({ repo: "ACME/OTHER" }).map((lane) => lane.title)).toEqual(["Lane b"]);
    expect(listLanes({ includeTerminal: false }).map((lane) => lane.title)).toEqual(["Lane b"]);
    expect(listLanes({ phase: ["cancelled"] }).map((lane) => lane.id)).toEqual([a.id]);
    expect(listLanes({ ownerBotId: "implementer-a" })).toHaveLength(1);
  });

  it("waitLane reports completion, or times out with finished=false", async () => {
    const a = upsertLane(laneInput("a"));
    const pending = await waitLane(a.id, { timeoutMs: 20, pollMs: 10 });
    expect(pending.finished).toBe(false);
    setTimeout(() => transition(a.id, "done", { outcome: "KEEP_DRAFT", changedFiles: ["server/x.ts"] }), 15);
    const report = await waitLane(a.id, { timeoutMs: 2_000, pollMs: 10 });
    expect(report).toMatchObject({ id: a.id, phase: "done", finished: true, outcome: "KEEP_DRAFT", changedFiles: ["server/x.ts"] });
    expect(report.lastEvidence).toMatchObject({ kind: "phase", ref: "ready->done" });
  });
});
