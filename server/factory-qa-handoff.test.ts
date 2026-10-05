// QA is performed outside OMB. Every QA entry point that is still routed
// rejects with qa_outside_omb, writes nothing, and starts nothing. The
// stored-task fixture below is synthetic: it has the shape of a task that
// was waiting on QA (waiting_qa, a QA seat, an undelivered review handoff,
// a sealed candidate, and a rejected QA SHA). No live task is loaded.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { FACTORY_SPECIALISTS, type FactorySpecialistId } from "./factory-boundary.ts";
import { FACTORY_DESK_HTML } from "./factory-desk-page.ts";
import {
  FACTORY_ONBOARDING,
  FactoryDispatchError,
  IMPLEMENTER_ID,
  QA_OUTSIDE_OMB,
  completeFactoryTurn,
  createFactoryTask,
  deliverHandoff,
  factoryTurnGuard,
  getFactoryTask,
  harvestFactoryTask,
  launchFactoryTask,
  listFactoryTasks,
  recoverFactoryTasks,
  shipFactoryTask,
  unavailableFactoryRoles,
  waitFactoryTask,
  _resetFactoryDispatch,
  type FactoryBot,
  type FactoryCompletionDeps,
} from "./factory-dispatch.ts";
import { json, readBody } from "./harness/http.ts";
import { createFactoryRoutes } from "./routes/factory.ts";
import { PASS, dispatchRoutes } from "./routes/table.ts";

const QA_ID = "223e5e26-37e4-42e3-9026-5983b66a17aa";
const DEAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REJECTED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FIXTURE_TASK = "00000000-0000-4000-8000-0000000000a1";
const FIXTURE_HANDOFF = "00000000-0000-4000-8000-0000000000b1";
const FIXTURE_SESSION = "00000000-0000-4000-8000-0000000000c1";
const FIXTURE_REJECTION = "00000000-0000-4000-8000-0000000000d1";
const FIXTURE_THREAD = "fixture-qa-thread";

const store = (): string => join(DATA_DIR, "factory-tasks.json");
const worktreesDir = (): string => join(DATA_DIR, "factory-worktrees");
const worktreeCount = (): number => (existsSync(worktreesDir()) ? readdirSync(worktreesDir()).length : 0);

function initRepo(): { repo: string; sha: string } {
  const repo = mkdtempSync(join(tmpdir(), "omb-noqa-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email factory@example.com", { cwd: repo });
  execSync("git config user.name factory", { cwd: repo });
  writeFileSync(join(repo, "README"), "base\n");
  execSync("git add README && git commit -m base", { cwd: repo });
  return { repo, sha: execSync("git rev-parse HEAD", { cwd: repo }).toString().trim() };
}

function commit(worktree: string, body: string): string {
  writeFileSync(join(worktree, "README"), body);
  execSync("git add README && git commit -m change", { cwd: worktree });
  return execSync("git rev-parse HEAD", { cwd: worktree }).toString().trim();
}

function local() {
  let n = 0;
  const threads: { threadId: string; cwd?: string }[] = [];
  const created: string[] = [];
  const bot = (id: string): FactoryBot => ({ id, model: "claude-opus-5-5", driverKind: "claudeAgent" });
  const createThread = (id: string) => {
    const threadId = `noqa-${id.slice(0, 8)}-${n++}`;
    threads.push({ threadId });
    created.push(id);
    return { threadId };
  };
  const pinCwd = (_id: string, threadId: string, cwd: string) => {
    const row = threads.find((item) => item.threadId === threadId);
    if (row) row.cwd = cwd;
  };
  return { threads, created, bot, createThread, pinCwd };
}

function intake(repo: string, sha: string, specialistId: string = IMPLEMENTER_ID, extra: Record<string, unknown> = {}) {
  return {
    objective: "Add a harmless line",
    specialistId,
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: sha,
    acceptance: "README contains harmless",
    dependencies: [],
    requiredEvidence: ["commit"],
    owner: "Bryant Thornton",
    authority: "qa outside omb proof",
    ...extra,
  };
}

/** A stored task that was waiting on QA before QA moved out of OMB. */
function writeStoredQaTask(): { repo: string; worktree: string; built: string } {
  const { repo, sha } = initRepo();
  const built = commit(repo, "base\nsealed\n");
  const worktree = join(mkdtempSync(join(tmpdir(), "omb-noqa-wt-")), "wt");
  execSync(`git worktree add --detach ${JSON.stringify(worktree)} ${built}`, { cwd: repo });
  const tree = execFileSync("git", ["rev-parse", `${built}^{tree}`], { cwd: worktree, encoding: "utf8" }).trim();
  const now = Date.now();
  const task = {
    id: FIXTURE_TASK,
    objective: "Review the sealed candidate",
    specialistId: QA_ID,
    specialistKey: "independent-qa",
    role: "qa",
    model: "claude-opus-5-5",
    permissions: "auto",
    repo,
    baseSha: sha,
    acceptance: "review only",
    dependencies: [],
    requiredEvidence: ["review"],
    status: "waiting_qa",
    worktree,
    sessionId: FIXTURE_SESSION,
    ombThreadId: FIXTURE_THREAD,
    threads: [{ specialistId: QA_ID, threadId: FIXTURE_THREAD }],
    resultSha: built,
    headSha: built,
    evidence: [{ at: now, kind: "commit", ref: built }],
    checks: [],
    implementerId: IMPLEMENTER_ID,
    assignedReviewerId: QA_ID,
    phase: "review",
    writerLock: "review",
    generation: 1,
    branch: "HEAD",
    revisions: [
      { id: "00000000-0000-4000-8000-0000000000e1", kind: "candidate", sessionId: "00000000-0000-4000-8000-0000000000f1", specialistId: IMPLEMENTER_ID, generation: 1, sha: built, tree, worktree, evidence: [], findings: [], nextAction: `sealed candidate ${built}`, createdAt: now },
      { id: FIXTURE_REJECTION, kind: "rejection", sessionId: FIXTURE_SESSION, specialistId: QA_ID, generation: 1, sha: REJECTED_SHA, evidence: [], findings: [`claimed ${REJECTED_SHA}`], nextAction: `rejected stale SHA ${REJECTED_SHA}`, createdAt: now },
    ],
    handoffs: [{
      id: FIXTURE_HANDOFF,
      taskId: FIXTURE_TASK,
      stage: "review",
      repo,
      worktree,
      inputSha: built,
      resultSha: built,
      fromSpecialistId: IMPLEMENTER_ID,
      toSpecialistId: QA_ID,
      summary: "fixture review handoff",
      requiredEvidence: ["review"],
      checks: [],
      findings: [],
      nextAction: `fresh independent QA of sealed candidate ${built}`,
      createdAt: now,
    }],
    owner: "Bryant Thornton",
    authority: "fixture",
    createdAt: now,
    updatedAt: now,
    nextAction: `fresh independent QA of sealed candidate ${built}`,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(store(), JSON.stringify({ version: 1, tasks: [task], unavailableRoles: [] }));
  _resetFactoryDispatch();
  return { repo, worktree, built };
}

function expectQaOutside(fn: () => unknown): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(FactoryDispatchError);
  expect((thrown as FactoryDispatchError).code).toBe("qa_outside_omb");
  expect((thrown as FactoryDispatchError).message).toContain(QA_OUTSIDE_OMB);
}

async function expectQaOutsideAsync(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(FactoryDispatchError);
  expect((error as FactoryDispatchError).code).toBe("qa_outside_omb");
}

beforeEach(() => {
  try { unlinkSync(store()); } catch { /* fresh */ }
  _resetFactoryDispatch();
});

describe("QA intake is rejected before anything is written", () => {
  it("refuses Independent QA and every other non-implementer seat without a worktree, thread, or unavailable-role record", () => {
    const { repo, sha } = initRepo();
    const before = worktreeCount();
    for (const id of Object.keys(FACTORY_SPECIALISTS) as FactorySpecialistId[]) {
      if (FACTORY_SPECIALISTS[id].role === "implementer") continue;
      const deps = local();
      // Even a seat whose fence could not be applied is refused as QA first.
      expectQaOutside(() => createFactoryTask(intake(repo, sha, id, { dispatchKey: id }), { ...deps, bot: (botId) => ({ id: botId, model: "claude-opus-5-5", driverKind: "codex" }) }));
      expect(deps.created).toEqual([]);
    }
    expect(listFactoryTasks()).toEqual([]);
    expect(unavailableFactoryRoles()).toEqual([]);
    expect(existsSync(store())).toBe(false);
    expect(worktreeCount()).toBe(before);
  });

  it("refuses QA-only and QA-seat intake fields instead of ignoring them", () => {
    const { repo, sha } = initRepo();
    const head = commit(repo, "base\nreviewed\n");
    for (const extra of [
      { qaOfTaskId: FIXTURE_TASK },
      { headSha: head },
      { prUrl: "https://github.com/example/repo/pull/8" },
      { qaDisposition: "CLEAR" },
      { reviewedSha: head },
      { reviewerId: QA_ID },
      { testerId: "1872d149-0be3-42c6-9218-3ea7d56609a4" },
      { releaseId: "bb034770-3b5a-44de-9ffe-1d851a093afe" },
      { remediationLimit: 2 },
    ]) {
      const deps = local();
      expectQaOutside(() => createFactoryTask(intake(repo, sha, IMPLEMENTER_ID, extra), deps));
      expect(deps.created).toEqual([]);
    }
    expect(existsSync(store())).toBe(false);
    expect(worktreeCount()).toBe(0);
  });
});

describe("a stored QA task loads and starts nothing", () => {
  it("lists a waiting_qa QA task, then refuses launch, harvest, delivery, a turn, and the ship gate without changing the store", async () => {
    const fixture = writeStoredQaTask();
    const listed = listFactoryTasks();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.state).toBe("waiting_qa");
    expect(listed[0]?.quiet).toBe(true);
    const bytes = readFileSync(store(), "utf8");
    const deps = local();
    let starts = 0;
    const start = () => { starts += 1; };

    await expectQaOutsideAsync(launchFactoryTask(FIXTURE_TASK, { start }));
    expectQaOutside(() => harvestFactoryTask(FIXTURE_TASK, {
      sessionId: FIXTURE_SESSION,
      worktree: fixture.worktree,
      resultSha: fixture.built,
      reviewedSha: fixture.built,
      qaDisposition: "CLEAR",
      evidence: [{ kind: "review", ref: fixture.built }],
    }));
    // A mismatched QA SHA is refused too; it is not turned into a new QA handoff.
    expectQaOutside(() => harvestFactoryTask(FIXTURE_TASK, {
      sessionId: FIXTURE_SESSION,
      worktree: fixture.worktree,
      resultSha: DEAD,
      evidence: [{ kind: "note", ref: DEAD }],
    }));
    await expectQaOutsideAsync(deliverHandoff(FIXTURE_TASK, { ...deps, start }, { handoffId: FIXTURE_HANDOFF }));
    await expectQaOutsideAsync(deliverHandoff(FIXTURE_TASK, { ...deps, start }));
    expectQaOutside(() => factoryTurnGuard(FIXTURE_THREAD));
    expectQaOutside(() => shipFactoryTask(FIXTURE_TASK, {}));

    expect(starts).toBe(0);
    expect(deps.created).toEqual([]);
    expect(readFileSync(store(), "utf8")).toBe(bytes);
    const after = getFactoryTask(FIXTURE_TASK)!;
    expect(after.handoffs?.[0]?.deliveredAt).toBeUndefined();
    expect(after.qaDisposition).toBeUndefined();
    expect(after.revisions?.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-0000000000e1", FIXTURE_REJECTION]);
  });

  it("does not hand a finished QA turn to another QA session, and does not resume one on restart", async () => {
    const fixture = writeStoredQaTask();
    const raw = JSON.parse(readFileSync(store(), "utf8"));
    raw.tasks[0].status = "running";
    raw.tasks[0].provenSessionId = FIXTURE_SESSION;
    writeFileSync(store(), JSON.stringify(raw));
    _resetFactoryDispatch();
    const deps = local();
    let starts = 0;
    const host: FactoryCompletionDeps = { ok: true, ...deps, start: () => { starts += 1; } };
    const ended = await completeFactoryTurn(FIXTURE_THREAD, host);
    expect(starts).toBe(0);
    expect(deps.created).toEqual([]);
    expect(ended.task?.status).toBe("blocked");
    expect(ended.task?.blocker).toBe(QA_OUTSIDE_OMB);
    expect(ended.task?.qaDisposition).toBeUndefined();
    expect(ended.task?.handoffs?.[0]?.deliveredAt).toBeUndefined();
    expect(ended.task?.resultSha).toBe(fixture.built);
    const again = await completeFactoryTurn(FIXTURE_THREAD, host);
    expect(again.duplicate).toBe(true);
    expect(starts).toBe(0);

    raw.tasks[0].status = "running";
    writeFileSync(store(), JSON.stringify(raw));
    _resetFactoryDispatch();
    const recovered = recoverFactoryTasks();
    expect(recovered.restored).toEqual([]);
    expect(recovered.blocked).toEqual([FIXTURE_TASK]);
    expect(getFactoryTask(FIXTURE_TASK)?.blocker).toBe(QA_OUTSIDE_OMB);
  });

  it("refuses a wait into waiting_qa and keeps the stored writer lock of a legacy waiting_qa implementer task", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const task = createFactoryTask(intake(repo, sha), deps).task;
    expectQaOutside(() => waitFactoryTask(task.id, "waiting_qa"));
    expect(getFactoryTask(task.id)?.status).toBe("bound");
    const raw = JSON.parse(readFileSync(store(), "utf8"));
    raw.tasks[0].status = "waiting_qa";
    raw.tasks[0].phase = "review";
    raw.tasks[0].writerLock = "review";
    writeFileSync(store(), JSON.stringify(raw));
    _resetFactoryDispatch();
    expect(listFactoryTasks()[0]?.state).toBe("waiting_qa");
    // A stored waiting_qa writer still reserves the repository.
    expect(() => createFactoryTask(intake(repo, sha, IMPLEMENTER_ID, { dispatchKey: "second" }), local())).toThrow(/writer/);
    // And it does not move to QA from a harvest.
    expectQaOutside(() => harvestFactoryTask(task.id, {
      sessionId: task.sessionId,
      worktree: task.worktree,
      resultSha: sha,
      evidence: [{ kind: "commit", ref: sha }],
    }));
  });
});

describe("an implementer harvest cannot record QA", () => {
  it("refuses a QA disposition or reviewed SHA from the implementer session and writes nothing", async () => {
    const { repo, sha } = initRepo();
    const deps = local();
    const task = createFactoryTask(intake(repo, sha), deps).task;
    const launched = await launchFactoryTask(task.id, { start: () => {} });
    const built = commit(task.worktree!, "base\nharmless\n");
    const bytes = readFileSync(store(), "utf8");
    for (const extra of [{ qaDisposition: "CLEAR" }, { qaDisposition: "NOT_CLEAR" }, { reviewedSha: built }]) {
      expectQaOutside(() => harvestFactoryTask(task.id, {
        sessionId: launched.task.sessionId,
        worktree: task.worktree,
        resultSha: built,
        evidence: [{ kind: "commit", ref: built }],
        ...extra,
      }));
    }
    expect(readFileSync(store(), "utf8")).toBe(bytes);
    expect(getFactoryTask(task.id)?.status).toBe("running");
  });
});

describe("factory HTTP routes", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  async function serve(): Promise<{ base: string; turns: { botId: string; threadId: string }[]; created: string[] }> {
    const deps = local();
    const turns: { botId: string; threadId: string }[] = [];
    const routes = [createFactoryRoutes({
      bot: deps.bot,
      createThread: deps.createThread,
      pinCwd: deps.pinCwd,
      startTurn: async (botId, _text, threadId) => { turns.push({ botId, threadId }); },
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: PASS.toString() });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, turns, created: deps.created };
  }

  async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  it("answers 410 qa_outside_omb for QA routes and starts no turn, while implementation still launches", async () => {
    const http = await serve();
    const { repo, sha } = initRepo();

    const qa = await post(http.base, "/api/factory/tasks", intake(repo, sha, QA_ID));
    expect(qa.status).toBe(410);
    expect(qa.body.code).toBe("qa_outside_omb");
    expect(qa.body.error).toContain(QA_OUTSIDE_OMB);
    const qaOnly = await post(http.base, "/api/factory/tasks", intake(repo, sha, IMPLEMENTER_ID, { headSha: sha, prUrl: "https://github.com/example/repo/pull/8" }));
    expect(qaOnly.status).toBe(410);
    expect(http.created).toEqual([]);

    const created = await post(http.base, "/api/factory/tasks", intake(repo, sha));
    expect(created.status).toBe(201);
    const id = (created.body.task as { id: string }).id;
    const launched = await post(http.base, `/api/factory/tasks/${id}/launch`, {});
    expect(launched.status).toBe(200);
    expect(http.turns).toHaveLength(1);
    expect(http.turns[0]?.botId).toBe(IMPLEMENTER_ID);
    const task = getFactoryTask(id)!;
    const built = commit(task.worktree!, "base\nharmless\n");

    const qaHarvest = await post(http.base, `/api/factory/tasks/${id}/harvest`, {
      sessionId: task.sessionId, worktree: task.worktree, resultSha: built, reviewedSha: built, qaDisposition: "CLEAR", evidence: [{ kind: "review", ref: built }],
    });
    expect(qaHarvest.status).toBe(410);
    expect(qaHarvest.body.code).toBe("qa_outside_omb");
    const wait = await post(http.base, `/api/factory/tasks/${id}/wait`, { status: "waiting_qa" });
    expect(wait.status).toBe(410);
    const ship = await post(http.base, `/api/factory/tasks/${id}/ship`, {});
    expect(ship.status).toBe(410);

    // A desk harvest during the writer session is evidence only; it starts nothing.
    const desk = await post(http.base, `/api/factory/tasks/${id}/harvest`, {
      sessionId: task.sessionId, worktree: task.worktree, resultSha: built, evidence: [{ kind: "commit", ref: built }],
    });
    expect(desk.status).toBe(200);
    expect((desk.body.task as { state: string }).state).toBe("running");
    expect(http.turns).toHaveLength(1);
    expect(http.created).toEqual([IMPLEMENTER_ID]);
  });

  it("answers 410 for a stored review handoff delivery and starts no turn", async () => {
    writeStoredQaTask();
    const http = await serve();
    const delivered = await post(http.base, `/api/factory/tasks/${FIXTURE_TASK}/deliver`, { handoffId: FIXTURE_HANDOFF });
    expect(delivered.status).toBe(410);
    expect(delivered.body.code).toBe("qa_outside_omb");
    const launched = await post(http.base, `/api/factory/tasks/${FIXTURE_TASK}/launch`, {});
    expect(launched.status).toBe(410);
    expect(http.turns).toEqual([]);
    expect(http.created).toEqual([]);
  });
});

describe("no QA surface is offered", () => {
  it("the desk offers only the implementer and no QA-only field, QA wait, or ship gate", () => {
    expect(FACTORY_DESK_HTML).not.toContain(QA_ID);
    expect(FACTORY_DESK_HTML).not.toContain("Independent QA</option>");
    expect(FACTORY_DESK_HTML).not.toContain('id="headSha"');
    expect(FACTORY_DESK_HTML).not.toContain('id="prUrl"');
    expect(FACTORY_DESK_HTML).not.toContain('value="waiting_qa"');
    expect(FACTORY_DESK_HTML).not.toContain('id="ship"');
    expect(FACTORY_DESK_HTML).toContain("QA and independent review are performed outside OMB");
  });

  it("the onboarding text does not claim a QA boundary", () => {
    expect(FACTORY_ONBOARDING).toContain("QA and independent review are performed outside OMB");
    expect(FACTORY_ONBOARDING).not.toMatch(/read-only QA lease|read-only lease|Only the assigned Independent QA specialist records/);
    // A Windows checkout may convert the doc to CRLF; compare the text, not the line endings.
    expect(readFileSync(join(process.cwd(), "docs", "factory-onboarding.md"), "utf8").replace(/\r\n/g, "\n")).toBe(FACTORY_ONBOARDING);
  });
});
