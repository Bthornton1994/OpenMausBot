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

/** A lane as stored on disk (say, by an older tool), parked in qa_wait on SHA_A. */
function storedHeld(id: string, fields: Record<string, unknown> = {}) {
  const now = Date.now();
  return { ...laneInput(id), id, phase: "qa_wait", fullSha: SHA_A, evidence: [], createdAt: now, updatedAt: now, ...fields };
}

const store = (...stored: Record<string, unknown>[]) => writeFileSync(FILE, JSON.stringify({ version: 1, lanes: stored }));

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
    expect(reviewed.evidence.at(-1)).toMatchObject({ kind: "qa", ref: "_cos/QA_DIGEST.md", note: "PASS by qa-bot" });
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

describe("factory lanes: QA hold freezes the reviewer (t1755u)", () => {
  it("refuses to swap or clear a held lane's reviewer by transition or upsert, and writes nothing", () => {
    const lane = heldByQa("a");
    const before = getLane(lane.id)!;
    for (const reviewerBotId of ["qa-bot-2", ""]) {
      expectLaneError(() => transition(lane.id, "qa_wait", { reviewerBotId }), "ineligible", /its reviewer qa-bot is frozen/);
      expectLaneError(() => upsertLane({ ...laneInput("a"), id: lane.id, reviewerBotId }), "ineligible", /its reviewer qa-bot is frozen/);
    }
    expect(getLane(lane.id)).toEqual(before);

    // Nor in the move that ends the hold.
    verdict(lane.id, "PASS");
    expectLaneError(() => transition(lane.id, "done", { reviewerBotId: "qa-bot-2" }), "ineligible", /its reviewer qa-bot is frozen/);
    expect(getLane(lane.id)).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot" });

    // Restating the assigned reviewer is not a change.
    expect(upsertLane({ ...laneInput("a"), id: lane.id, reviewerBotId: "qa-bot", nextAction: "await QA" })).toMatchObject({
      phase: "qa_wait",
      reviewerBotId: "qa-bot",
      nextAction: "await QA",
    });
    expect(transition(lane.id, "done", { reviewerBotId: "qa-bot", outcome: "KEEP_DRAFT" })).toMatchObject({ phase: "done", reviewerBotId: "qa-bot" });
  });

  it("lets a held lane with no reviewer be given one, since no verdict could release it otherwise, then freezes it", () => {
    const lane = upsertLane(laneInput("a", { phase: "qa_wait", fullSha: SHA_A }));
    expectLaneError(() => verdict(lane.id, "PASS"), "qa_independence", /reviewed by nobody yet/);
    expect(transition(lane.id, "qa_wait", { reviewerBotId: "qa-bot" }).reviewerBotId).toBe("qa-bot");
    expectLaneError(() => transition(lane.id, "qa_wait", { reviewerBotId: "qa-bot-2" }), "ineligible", /its reviewer qa-bot is frozen/);
    verdict(lane.id, "PASS");
    expect(transition(lane.id, "done", { outcome: "KEEP_DRAFT" }).phase).toBe("done");
  });

  it("unfreezes the reviewer once the lane leaves qa_wait", () => {
    const lane = heldByQa("a");
    verdict(lane.id, "FAIL");
    transition(lane.id, "running");
    expect(transition(lane.id, "running", { reviewerBotId: "qa-bot-2" }).reviewerBotId).toBe("qa-bot-2");
    expect(upsertLane({ ...laneInput("a"), id: lane.id, reviewerBotId: "qa-bot-3" }).reviewerBotId).toBe("qa-bot-3");
    // The next round may enter qa_wait under a new reviewer, who alone can release it.
    expect(transition(lane.id, "qa_wait", { fullSha: "b".repeat(40), reviewerBotId: "qa-bot-4" })).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot-4" });
    expectLaneError(() => verdict(lane.id, "PASS"), "qa_independence", /reviewed by qa-bot-4, not qa-bot/);
  });

  it("names the reviewer who recorded the FAIL in the qa and rework evidence", () => {
    const lane = heldByQa("a");
    const failed = recordQaDisposition(lane.id, { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md", note: "missing test" });
    expect(failed.evidence.at(-1)).toEqual({ at: expect.any(Number), kind: "qa", ref: "_cos/QA_DIGEST.md", note: "FAIL by qa-bot — missing test" });
    // The handoff cannot swap in another reviewer to take the credit…
    expectLaneError(() => transition(lane.id, "running", { reviewerBotId: "qa-bot-2" }), "ineligible", /its reviewer qa-bot is frozen/);
    expect(getLane(lane.id)).toEqual(failed);
    // …so the rework note names the reviewer who failed it.
    const rework = transition(lane.id, "running", { reviewerBotId: "qa-bot" });
    expect(rework.evidence.at(-2)).toEqual({
      at: expect.any(Number),
      kind: "rework",
      ref: "_cos/QA_DIGEST.md",
      note: "QA FAIL by qa-bot handed the lane back for rework",
    });
  });

  it("never credits a reviewer assigned on the handoff with a FAIL recorded before them", () => {
    // Stored lanes (say, written by an older tool) holding a FAIL but no
    // reviewer. t1756u F-1: no reviewer recorded that FAIL, so it counts for nothing.
    const fail = { qaDisposition: "FAIL", evidence: [{ at: Date.now(), kind: "qa", ref: "_cos/QA_DIGEST.md", note: "FAIL" }] };
    store(storedHeld("a", fail), storedHeld("b", fail));
    // A reviewer given to such a hold starts from no verdict…
    const assigned = upsertLane({ ...laneInput("b"), id: "b", reviewerBotId: "qa-bot-2" });
    expect(assigned).toMatchObject({ phase: "qa_wait", reviewerBotId: "qa-bot-2" });
    expect(assigned.qaDisposition).toBeUndefined();
    // …and the stored FAIL neither releases the hold nor credits one assigned on the way out.
    expect(getLane("a")!.qaDisposition).toBeUndefined();
    expectLaneError(() => transition("a", "running", { reviewerBotId: "qa-bot-2" }), "ineligible", /no QA verdict recorded/);
    expect(transition("a", "qa_wait", { reviewerBotId: "qa-bot-2" }).qaDisposition).toBeUndefined();
    expectLaneError(() => transition("a", "running"), "ineligible", /no QA verdict recorded/);
    // The lane leaves only on the new reviewer's own FAIL, which the rework note names.
    recordQaDisposition("a", { reviewerBotId: "qa-bot-2", disposition: "FAIL", ref: "_cos/QA_DIGEST-2.md" });
    const rework = transition("a", "running");
    expect(rework).toMatchObject({ phase: "running", reviewerBotId: "qa-bot-2" });
    expect(rework.evidence.at(-2)).toMatchObject({ kind: "rework", ref: "_cos/QA_DIGEST-2.md", note: "QA FAIL by qa-bot-2 handed the lane back for rework" });
  });
});

describe("factory lanes: verdicts need a real reviewer (t1756u)", () => {
  it("F-1/F-2: on load, keeps a held lane's verdict only when it has a valid independent reviewer", () => {
    const pass = { qaDisposition: "PASS" };
    store(
      storedHeld("none", pass),
      storedHeld("blank", { ...pass, reviewerBotId: "" }),
      storedHeld("spaces", { ...pass, reviewerBotId: "   " }),
      storedHeld("self", { ...pass, reviewerBotId: "implementer-self" }),
      storedHeld("valid", { ...pass, reviewerBotId: "qa-bot" }),
      storedHeld("finished", { ...pass, phase: "done" }),
    );
    expect(listLanes().map(({ id, reviewerBotId, qaDisposition }) => ({ id, reviewerBotId, qaDisposition }))).toEqual([
      { id: "none" },
      { id: "blank" },
      { id: "spaces" },
      { id: "self" },
      { id: "valid", reviewerBotId: "qa-bot", qaDisposition: "PASS" },
      // A finished lane never moves again; it keeps the verdict it finished on.
      { id: "finished", qaDisposition: "PASS" },
    ]);
  });

  it("F-2: drops a stored self-review with its reviewer, so a held lane cannot finish on it", () => {
    store(
      storedHeld("a", {
        reviewerBotId: "implementer-a",
        qaDisposition: "PASS",
        evidence: [{ at: Date.now(), kind: "qa", ref: "_cos/QA_DIGEST.md", note: "PASS by implementer-a" }],
      }),
    );
    const loaded = getLane("a")!;
    expect(loaded.reviewerBotId).toBeUndefined();
    expect(loaded.qaDisposition).toBeUndefined();
    expectLaneError(() => transition("a", "done"), "ineligible", /no QA verdict recorded/);
    transition("a", "qa_wait", { reviewerBotId: "qa-bot" });
    expectLaneError(() => transition("a", "done"), "ineligible", /no QA verdict recorded/);
    verdict("a", "PASS");
    // A verdict from the lane's own reviewer survives a restart.
    _resetFactoryLanes();
    expect(getLane("a")).toMatchObject({ reviewerBotId: "qa-bot", qaDisposition: "PASS" });
    expect(transition("a", "done", { outcome: "KEEP_DRAFT" })).toMatchObject({ phase: "done", reviewerBotId: "qa-bot", qaDisposition: "PASS" });
  });

  it("F-3: refuses a QA verdict on a finished lane, which keeps the verdict it finished on", () => {
    for (const [phase, recorded, late] of [
      ["done", "PASS", "FAIL"],
      ["failed", "FAIL", "PASS"],
      ["cancelled", "BLOCKED", "PASS"],
    ] as const) {
      const lane = heldByQa(phase);
      verdict(lane.id, recorded);
      transition(lane.id, phase);
      const onDisk = readFileSync(FILE, "utf8");
      expectLaneError(() => verdict(lane.id, late), "terminal");
      expect(readFileSync(FILE, "utf8")).toBe(onDisk);
      expect(getLane(lane.id)).toMatchObject({ phase, qaDisposition: recorded });
      // Late QA still reaches the audit trail, as evidence rather than a verdict.
      expect(appendEvidence(lane.id, { kind: "qa", ref: "_cos/LATE_QA.md", note: `${late} by qa-bot` })).toMatchObject({ phase, qaDisposition: recorded });
    }
  });

  it("F-4: treats a blank reviewer id as none, so it neither freezes a hold nor records a verdict", () => {
    const lane = upsertLane(laneInput("a", { phase: "qa_wait", fullSha: SHA_A, reviewerBotId: "   " }));
    expect(lane.reviewerBotId).toBeUndefined();
    for (const blank of ["", "   "]) {
      expect(transition(lane.id, "qa_wait", { reviewerBotId: blank }).reviewerBotId).toBeUndefined();
      expect(upsertLane({ ...laneInput("a"), id: lane.id, reviewerBotId: blank }).reviewerBotId).toBeUndefined();
      expectLaneError(() => recordQaDisposition(lane.id, { reviewerBotId: blank, disposition: "FAIL", ref: "_cos/QA_DIGEST.md" }), "invalid");
    }
    expect(getLane(lane.id)).toMatchObject({ phase: "qa_wait", evidence: [] });
    expectLaneError(() => transition(lane.id, "running"), "ineligible", /no QA verdict recorded/);
    // A real reviewer can still be given the hold, and only their verdict releases it.
    expect(transition(lane.id, "qa_wait", { reviewerBotId: "qa-bot" }).reviewerBotId).toBe("qa-bot");
    verdict(lane.id, "FAIL");
    const rework = transition(lane.id, "running");
    expect(rework.evidence.at(-2)).toMatchObject({ kind: "rework", note: "QA FAIL by qa-bot handed the lane back for rework" });
    // Outside the hold, a blank clears the reviewer, as loading would.
    expect(transition(lane.id, "running", { reviewerBotId: "" }).reviewerBotId).toBeUndefined();
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
