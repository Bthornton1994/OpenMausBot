// Factory lanes + protect gate — harvest dispatch against the CoS protect SoT
// (PROTECTED_SESSIONS.json + FROZEN_TIPS.json). Every gate-on test points at
// the checked-in fixture directory or a throwaway copy under DATA_DIR; the
// shared setup scrubs COS_FACTORY_* so nothing reads the box's live list.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  claimNextEligible,
  claimWorktree,
  FactoryLaneError,
  getLane,
  listLanes,
  recordQaDisposition,
  releaseOwnership,
  transition,
  upsertLane,
  waitLane,
  _resetFactoryLanes,
  type FactoryLane,
  type FactoryLaneErrorCode,
} from "./factory-lanes.ts";
import { FROZEN_TIPS_FILE, loadProtectSoT, PROTECTED_SESSIONS_FILE, resolveProtectDir } from "./factory-protect-gate.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t1734u-protect");
const VA = { repo: "Bthornton1994/Virtual-Assistant", branch: "cos/rr-d1d4-operator-only-19d4f99e" };
const VA_TIP = "ca813c0dd29e5c38063efa571d809b0dbd5a4bfb";

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

const claimOwn = (lane: FactoryLane, extra: { protectDir?: string } = {}) =>
  claimWorktree({ laneId: lane.id, ownerBotId: lane.ownerBotId, repo: lane.repo, branch: lane.branch, worktreePath: lane.worktreePath, ...extra });

const protectNotes = (id: string): string[] =>
  getLane(id)!.evidence.filter((entry) => entry.kind === "protect").map((entry) => entry.note ?? "");

/** A throwaway protect dir under DATA_DIR holding copies of chosen fixture files. */
function scratchProtectDir(files: readonly string[] = [PROTECTED_SESSIONS_FILE, FROZEN_TIPS_FILE]): string {
  const dir = mkdtempSync(join(DATA_DIR, "protect-"));
  for (const name of files) copyFileSync(join(FIXTURE, name), join(dir, name));
  return dir;
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const name of readdirSync(DATA_DIR)) {
    if (name.startsWith("factory-lanes.json") || name.startsWith("protect-") || name === "cos-root") {
      rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    }
  }
  _resetFactoryLanes();
  process.env.COS_FACTORY_PROTECT_DIR = FIXTURE;
});

afterEach(() => {
  delete process.env.COS_FACTORY_PROTECT_DIR;
  delete process.env.COS_FACTORY_ROOT;
});

describe("protect gate: harvest dispatch while lanes wait", () => {
  it("dispatches an independent ready lane while others wait on CI and QA, with the gate on", () => {
    const qa = upsertLane(laneInput("qa-wait", { phase: "qa_wait", reviewerBotId: "qa-bot" }));
    const ci = upsertLane(laneInput("ci-wait", { phase: "ci_wait" }));
    const next = upsertLane(laneInput("next"));

    const claimed = claimNextEligible();
    expect(claimed?.id).toBe(next.id);
    expect(claimed?.phase).toBe("running");
    const claim = claimed!.evidence.find((entry) => entry.kind === "claim")!;
    expect(claim.note).toContain(`${qa.id}:qa_wait`);
    expect(claim.note).toContain(`${ci.id}:ci_wait`);
    expect(claim.note).toContain("protect ALLOW allow");

    // The waiting lanes are untouched: still waiting, still holding their tips.
    expect(getLane(qa.id)!.phase).toBe("qa_wait");
    expect(getLane(ci.id)!.phase).toBe("ci_wait");
  });
});

describe("protect gate: denials", () => {
  it("skips protected sessions, frozen tips, blocked lanes and ownership conflicts, and records why", () => {
    const waiting = upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const denied = {
      tipBranch: upsertLane(laneInput("tip-branch", { ...VA })),
      tipWorktree: upsertLane(laneInput("tip-wt", { repo: VA.repo, worktreePath: "c:/fixture/VA-rr-d1d4-wt/sub" })),
      tipSha: upsertLane(laneInput("tip-sha", { fullSha: VA_TIP })),
      writerTarget: upsertLane(laneInput("writer", { agentSession: "session_fixture_rr_ir" })),
      sessionBranch: upsertLane(laneInput("sess-branch", { repo: "fixture/rr-ir", branch: "cos/rr-ir-review" })),
      sessionWorktree: upsertLane(laneInput("sess-wt", { worktreePath: "C:\\fixture\\react-doctor-wt" })),
    };
    const blocked = upsertLane(laneInput("blocked", { blocker: "owner decision pending" }));
    const overlapping = upsertLane(laneInput("overlap", { branch: waiting.branch, worktreePath: "C:\\work\\elsewhere" }));

    expect(claimNextEligible()).toBeNull();
    for (const lane of [...Object.values(denied), blocked, overlapping]) expect(getLane(lane.id)!.phase).toBe("ready");

    expect(protectNotes(denied.tipBranch.id)).toEqual([expect.stringMatching(/^DENY frozen_tip: same repo\+branch/)]);
    expect(protectNotes(denied.tipWorktree.id)).toEqual([expect.stringMatching(/^DENY frozen_tip: same worktree/)]);
    expect(protectNotes(denied.tipSha.id)).toEqual([expect.stringMatching(new RegExp(`^DENY frozen_tip: lane tip ${VA_TIP}`))]);
    expect(protectNotes(denied.writerTarget.id)).toEqual([expect.stringMatching(/^DENY protected_session: writer target is protected session session_fixture_rr_ir/)]);
    expect(protectNotes(denied.sessionBranch.id)).toEqual([expect.stringMatching(/^DENY protected_session: same repo\+branch/)]);
    expect(protectNotes(denied.sessionWorktree.id)).toEqual([expect.stringMatching(/^DENY protected_session: same worktree/)]);
    // Blocked and ownership-conflicting lanes are skipped before the gate.
    expect(protectNotes(blocked.id)).toEqual([]);
    expect(protectNotes(overlapping.id)).toEqual([]);

    // A manager loop asking again every tick does not flood the audit trail.
    expect(claimNextEligible()).toBeNull();
    expect(protectNotes(denied.tipBranch.id)).toHaveLength(1);

    // The direct claim paths refuse the same lanes.
    expectLaneError(() => claimOwn(denied.tipBranch), "ineligible", /frozen tip Bthornton1994\/Virtual-Assistant/);
    expectLaneError(() => claimOwn(denied.writerTarget), "ineligible", /session_fixture_rr_ir/);
    expectLaneError(() => transition(denied.sessionWorktree.id, "running"), "ineligible");
    expectLaneError(() => claimOwn(overlapping), "conflict");
    // A transition patch cannot slip a protected writer session past the gate.
    const sneaky = upsertLane(laneInput("sneaky"));
    expectLaneError(() => transition(sneaky.id, "running", { agentSession: "session_fixture_rr_ir" }), "ineligible");
    expect(getLane(sneaky.id)).toMatchObject({ phase: "ready" });
    expect(getLane(sneaky.id)!.agentSession).toBeUndefined();

    // Denials survive a reload from disk.
    _resetFactoryLanes();
    expect(protectNotes(denied.tipSha.id)).toHaveLength(1);
    expect(listLanes({ phase: "running" })).toEqual([]);
  });
});

describe("protect gate: QA is not implementation", () => {
  it("never claims a QA lane or a qa_wait lane through the implementer claim APIs", () => {
    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const qaWork = upsertLane(laneInput("qa-work", { role: "qa", ownerBotId: "qa-bot" }));
    expect(claimNextEligible()).toBeNull();
    expect(protectNotes(qaWork.id)).toEqual([expect.stringMatching(/^DENY qa_role:/)]);
    expectLaneError(() => claimOwn(qaWork), "ineligible", /QA work/);
    expectLaneError(() => transition(qaWork.id, "running"), "ineligible", /QA work/);

    // An implementer lane parked in qa_wait belongs to QA until it moves on.
    const underReview = upsertLane(laneInput("review", { phase: "qa_wait", reviewerBotId: "qa-bot" }));
    expectLaneError(() => claimOwn(underReview), "ineligible", /qa_wait/);

    // The role survives a reload.
    _resetFactoryLanes();
    expect(getLane(qaWork.id)!.role).toBe("qa");
  });

  it("applies the QA rules even with no protect directory configured", () => {
    delete process.env.COS_FACTORY_PROTECT_DIR;
    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const qaWork = upsertLane(laneInput("qa-work", { role: "qa", ownerBotId: "qa-bot" }));
    const underReview = upsertLane(laneInput("review", { phase: "qa_wait", reviewerBotId: "qa-bot" }));
    expect(claimNextEligible()).toBeNull();
    expectLaneError(() => claimOwn(qaWork), "ineligible");
    expectLaneError(() => claimOwn(underReview), "ineligible");
    expect(protectNotes(qaWork.id)).toEqual([expect.stringMatching(/^DENY qa_role:/)]);
    expect(getLane(qaWork.id)!.evidence.at(-1)?.ref).toBe("qa-rules");
  });

  it("records a QA verdict on a frozen tip without claiming it as a writer", () => {
    const tip = upsertLane(laneInput("va", { ...VA, phase: "qa_wait", reviewerBotId: "qa-bot", fullSha: VA_TIP }));
    const before = getLane(tip.id)!;
    const reviewed = recordQaDisposition(tip.id, { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" });
    expect(reviewed.qaDisposition).toBe("PASS");
    expect(reviewed.phase).toBe("qa_wait");
    expect(reviewed.claimedAt).toBe(before.claimedAt);
    expect(reviewed.evidence.map((entry) => entry.kind)).toEqual(["qa"]);
    // …while an implementer claim on that same frozen tip stays refused.
    const writer = upsertLane(laneInput("writer", { ...VA, worktreePath: "C:\\work\\va-writer" }));
    expectLaneError(() => claimOwn(writer), "ineligible", /frozen tip/);
  });

  it("t1754u: a transition cannot take a qa_wait lane back to running without QA FAIL, even where the gate would allow it", () => {
    const held = upsertLane(laneInput("held", { reviewerBotId: "qa-bot" }));
    transition(held.id, "running");
    transition(held.id, "qa_wait", { fullSha: "e".repeat(40) });
    const before = getLane(held.id)!;
    expectLaneError(() => transition(held.id, "running"), "ineligible", /held by QA in qa_wait \(no QA verdict recorded\); running needs QA FAIL/);
    recordQaDisposition(held.id, { reviewerBotId: "qa-bot", disposition: "PASS", ref: "_cos/QA_DIGEST.md" });
    expectLaneError(() => transition(held.id, "running"), "ineligible", /\(QA PASS\); running needs QA FAIL/);
    expect(getLane(held.id)!.evidence).toEqual([...before.evidence, expect.objectContaining({ kind: "qa", note: "PASS by qa-bot" })]);

    // Meanwhile the manager loop still dispatches disjoint work.
    const next = upsertLane(laneInput("next"));
    expect(claimNextEligible()?.id).toBe(next.id);

    // FAIL is the rework handoff. Implementer claims stay refused even then;
    // the handoff goes through transition, and through the gate.
    recordQaDisposition(held.id, { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md", note: "missing test" });
    expectLaneError(() => claimOwn(held), "ineligible", /qa_wait/);
    const rework = transition(held.id, "running");
    expect(rework.phase).toBe("running");
    expect(rework.evidence.slice(-3)).toEqual([
      expect.objectContaining({ kind: "protect", note: expect.stringMatching(/^ALLOW allow:/) }),
      expect.objectContaining({ kind: "rework", ref: "_cos/QA_DIGEST.md", note: expect.stringMatching(/QA FAIL by qa-bot/) }),
      expect.objectContaining({ kind: "phase", ref: "qa_wait->running" }),
    ]);
  });

  it("t1754u: a QA FAIL does not let rework onto a frozen tip or protected session", () => {
    const onTip = upsertLane(laneInput("va", { ...VA, phase: "qa_wait", reviewerBotId: "qa-bot", fullSha: VA_TIP }));
    recordQaDisposition(onTip.id, { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md" });
    expectLaneError(() => transition(onTip.id, "running"), "ineligible", /frozen tip/);
    expect(getLane(onTip.id)!.phase).toBe("qa_wait");

    const onSession = upsertLane(laneInput("sess", { phase: "qa_wait", reviewerBotId: "qa-bot", worktreePath: "C:\\fixture\\react-doctor-wt" }));
    recordQaDisposition(onSession.id, { reviewerBotId: "qa-bot", disposition: "FAIL", ref: "_cos/QA_DIGEST.md" });
    expectLaneError(() => transition(onSession.id, "running"), "ineligible", /protected session/);
    expect(getLane(onSession.id)!.phase).toBe("qa_wait");
  });
});

describe("protect gate: no double start, completion and recovery", () => {
  it("starts each ready lane once, keeps claims across reload, and re-dispatches only after release", async () => {
    const waiting = upsertLane(laneInput("wait", { phase: "qa_wait", reviewerBotId: "qa-bot" }));
    const b = upsertLane(laneInput("b"));
    const c = upsertLane(laneInput("c"));

    expect(claimNextEligible()?.id).toBe(b.id);
    expect(claimNextEligible()?.id).toBe(c.id);
    expect(claimNextEligible()).toBeNull();

    // Recovery: a fresh process sees the same claims and starts nothing again.
    _resetFactoryLanes();
    expect(claimNextEligible()).toBeNull();
    for (const id of [b.id, c.id]) {
      const lane = getLane(id)!;
      expect(lane.phase).toBe("running");
      expect(lane.claimedAt).toBeTypeOf("number");
      expect(lane.evidence.filter((entry) => entry.kind === "phase" && entry.ref === "ready->running")).toHaveLength(1);
    }

    // A second writer on a running lane's branch is refused.
    const rival = upsertLane(laneInput("rival", { branch: b.branch, worktreePath: "C:\\work\\wt-rival" }));
    expectLaneError(() => claimOwn(rival), "conflict");
    // Releasing the explicit claim of a running lane does not unfreeze it.
    releaseOwnership(b.id);
    expectLaneError(() => claimOwn(rival), "conflict");

    // Still running → waitLane does not report it finished.
    expect((await waitLane(b.id, { timeoutMs: 20, pollMs: 10 })).finished).toBe(false);

    // Completion releases ownership; the rival may now claim, through the gate.
    transition(b.id, "done", { outcome: "KEEP_DRAFT" });
    const rivalClaimed = claimOwn(rival);
    expect(rivalClaimed.claimedAt).toBeTypeOf("number");
    expect(rivalClaimed.evidence.map((entry) => entry.kind)).toEqual(["protect", "claim"]);
    expect(rivalClaimed.evidence[0]!.note).toMatch(/^ALLOW allow:/);
    // A finished lane is never dispatched again.
    expectLaneError(() => transition(b.id, "running"), "terminal");
    expect(getLane(waiting.id)!.phase).toBe("qa_wait");
  });
});

describe("protect gate: fail closed", () => {
  it("refuses every claim when a configured protect directory is missing a file", () => {
    process.env.COS_FACTORY_PROTECT_DIR = scratchProtectDir([PROTECTED_SESSIONS_FILE]);
    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const ready = upsertLane(laneInput("ready"));

    expectLaneError(() => claimNextEligible(), "ineligible", /FROZEN_TIPS\.json is missing/);
    expectLaneError(() => claimOwn(ready), "ineligible", /failing closed/);
    expectLaneError(() => transition(ready.id, "running"), "ineligible", /failing closed/);
    expect(getLane(ready.id)!.phase).toBe("ready");
    expect(getLane(ready.id)!.claimedAt).toBeUndefined();
    expect(protectNotes(ready.id)).toEqual([expect.stringMatching(/^DENY config: protect SoT unavailable/)]);
  });

  it("refuses on a missing directory, invalid JSON, or an invalid entry", () => {
    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const ready = upsertLane(laneInput("ready"));

    expectLaneError(() => claimNextEligible({ protectDir: join(DATA_DIR, "protect-nowhere") }), "ineligible", /missing/);

    const badJson = scratchProtectDir();
    writeFileSync(join(badJson, FROZEN_TIPS_FILE), "{not json");
    expectLaneError(() => claimOwn(ready, { protectDir: badJson }), "ineligible", /not valid JSON/);

    const shortSha = scratchProtectDir();
    writeFileSync(join(shortSha, FROZEN_TIPS_FILE), JSON.stringify({ tips: [{ ...VA, tipSha: "ca813c0" }] }));
    expectLaneError(() => claimNextEligible({ protectDir: shortSha }), "ineligible", /full 40-hex tipSha/);

    const noId = scratchProtectDir();
    writeFileSync(join(noId, PROTECTED_SESSIONS_FILE), JSON.stringify({ sessions: [{ repo: "x/y" }] }));
    expectLaneError(() => claimNextEligible({ protectDir: noId }), "ineligible", /no session id/);

    const wrongShape = scratchProtectDir();
    writeFileSync(join(wrongShape, PROTECTED_SESSIONS_FILE), JSON.stringify({ nothing: true }));
    expectLaneError(() => claimNextEligible({ protectDir: wrongShape }), "ineligible", /no sessions list/);

    expect(listLanes({ phase: "running" })).toEqual([]);
  });

  it("resolves COS_FACTORY_ROOT/protect, and stays ownership-only when nothing is configured", () => {
    delete process.env.COS_FACTORY_PROTECT_DIR;
    const root = join(DATA_DIR, "cos-root");
    mkdirSync(join(root, "protect"), { recursive: true });
    process.env.COS_FACTORY_ROOT = root;
    expect(resolveProtectDir()).toBe(join(root, "protect"));
    expect(resolveProtectDir("  C:\\explicit  ")).toBe("C:\\explicit");

    upsertLane(laneInput("wait", { phase: "ci_wait" }));
    const onTip = upsertLane(laneInput("va", { ...VA }));
    // Root set, protect/ empty → fail closed.
    expectLaneError(() => claimNextEligible(), "ineligible", /PROTECTED_SESSIONS\.json is missing/);
    // Root set, protect/ populated (with a PowerShell BOM) → the frozen tip is denied.
    for (const name of [PROTECTED_SESSIONS_FILE, FROZEN_TIPS_FILE]) {
      copyFileSync(join(FIXTURE, name), join(root, "protect", name));
    }
    const tips = join(root, "protect", FROZEN_TIPS_FILE);
    writeFileSync(tips, `\uFEFF${JSON.stringify({ tips: [{ ...VA, tipSha: VA_TIP }] })}`);
    expect(loadProtectSoT(join(root, "protect")).ok).toBe(true);
    expect(claimNextEligible()).toBeNull();
    expect(protectNotes(onTip.id)).toEqual([expect.stringMatching(/^DENY frozen_tip:/)]);

    // Nothing configured → the SoT is not consulted (documented ownership-only mode).
    delete process.env.COS_FACTORY_ROOT;
    expect(resolveProtectDir()).toBeNull();
    expect(claimNextEligible()?.id).toBe(onTip.id);
  });
});
