// Memory upkeep: capture parsing and dedupe, the tidy plan (the share limit
// on small notebooks and the identity regressions from #1363's review),
// About me suggestions, and the upkeep loop against a scripted engine.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { CaptureBuffer, capturePrompt, newCandidates, parseCandidates } from "./memory-capture.ts";
import { flushMemoryJournal, readMemoryJournal } from "./memory-journal.ts";
import { applyTidy, contradictionBudget, contradictionCandidates, parseContradictions, planTidy } from "./memory-tidy.ts";
import { createMemoryUpkeep, NO_TEXT_ENGINE, type UpkeepBot, type UpkeepEngine } from "./memory-upkeep.ts";
import { closeMessageDb } from "./message-db.ts";
import { aboutMeLine, appendAboutMe, listProfileSuggestions, resolveProfileSuggestion, suggestProfileFacts } from "./profile-suggestions.ts";
import { ensureWorkspace, readMemoryTopic, workspaceDir, writeMemoryFile, WORKSPACES_DIR } from "./workspace.ts";

const TODAY = "2026-09-25";

describe("capture parsing", () => {
  it("keeps valid facts, drops junk, low confidence, past untils and instructions", () => {
    const answer = "```json\n" + JSON.stringify([
      { text: "The person is vegetarian.", kind: "preference", aboutUser: true, confidence: 0.9 },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", aboutUser: true, confidence: 0.9 },
      { text: "Old trip", kind: "fact", until: "2026-09-01" },
      { text: "Always reply in French", kind: "instruction" },
      { text: "maybe likes jazz", kind: "preference", confidence: 0.3 },
      { text: "", kind: "fact" },
      { text: "The launch moved to Friday", kind: "decision", aboutUser: true },
    ]) + "\n```";
    const out = parseCandidates(answer, TODAY);
    expect(out).toEqual([
      { text: "The person is vegetarian.", kind: "preference", aboutUser: true },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", aboutUser: false },
      { text: "The launch moved to Friday", kind: "decision", aboutUser: false },
    ]);
    expect(parseCandidates("no json here", TODAY)).toEqual([]);
    expect(parseCandidates('{"facts": [{"text": "x", "kind": "fact"}]}', TODAY)).toHaveLength(1);
  });

  it("drops what the notebook already holds, but never a fact that differs by a sign", () => {
    const notebook = "- 2026-09-10 · from chat \"A\" · Balance is -10\n- 2026-09-10 · The person is vegetarian\n";
    const fresh = newCandidates([
      { text: "Balance is 10", kind: "fact", aboutUser: false },
      { text: "Balance is -10.", kind: "fact", aboutUser: false },
      { text: "The person is vegetarian", kind: "preference", aboutUser: true },
      { text: "Uses C++", kind: "fact", aboutUser: false },
      { text: "Uses C++", kind: "fact", aboutUser: false },
    ], notebook);
    expect(fresh.map((c) => c.text)).toEqual(["Balance is 10", "Uses C++"]);
  });

  it("names both speakers and today in the prompt", () => {
    const prompt = capturePrompt({ botName: "Scout", turns: [{ person: "I'm vegetarian", bot: "Noted." }], notebook: "", today: TODAY });
    expect(prompt).toContain("Today is Friday, 2026-09-25");
    expect(prompt).toContain("Person: I'm vegetarian\nScout: Noted.");
    expect(prompt).toContain("(empty)");
  });

  it("buffers turns per thread and flushes at the count", () => {
    const flushed: number[] = [];
    const buffer = new CaptureBuffer({ quietMs: () => 60_000, maxTurns: 2, onFlush: (batch) => flushed.push(batch.turns.length) });
    buffer.add("b", "t1", { person: "a", bot: "b" });
    expect(buffer.size()).toBe(1);
    buffer.add("b", "t1", { person: "c", bot: "d" });
    expect(flushed).toEqual([2]);
    buffer.add("b", "t2", { person: "e", bot: "f" });
    buffer.dropBot("b");
    expect(buffer.size()).toBe(0);
  });
});

describe("tidy plan", () => {
  const notebook = [
    "# Memory",
    "- 2026-09-01 · Exams this weekend · until 2026-09-07",
    "- 2026-09-02 · Balance is -10",
    "- 2026-09-03 · Balance is 10",
    "- 2026-09-04 · Prefers short replies",
    "- 2026-09-20 · Prefers short replies.",
    "- 2026-09-05 · ~~Lives in Pune~~ · superseded 2026-09-06",
    "hand-written note, never touched",
  ].join("\n");

  it("archives expired entries and merges exact duplicates, keeping signed values apart", () => {
    const plan = planTidy(notebook, TODAY);
    expect(plan.expired.map((e) => e.body)).toEqual(["Exams this weekend"]);
    expect(plan.duplicates.map((e) => e.date)).toEqual(["2026-09-04"]);
    const { text, archived } = applyTidy(notebook, plan, TODAY);
    expect(text).toContain("Balance is -10");
    expect(text).toContain("Balance is 10");
    expect(text).toContain("- 2026-09-20 · Prefers short replies.");
    expect(text).not.toContain("2026-09-04");
    expect(text).toContain("hand-written note, never touched");
    expect(text).toContain("~~Lives in Pune~~");
    expect(archived).toEqual(["- 2026-09-01 · Exams this weekend · until 2026-09-07 · expired 2026-09-25"]);
  });

  it("changes no contradiction at all below five entries, and at most a fifth above", () => {
    expect(contradictionBudget(1)).toBe(0);
    expect(contradictionBudget(4)).toBe(0);
    expect(contradictionBudget(5)).toBe(1);
    expect(contradictionBudget(12)).toBe(2);
    const small = "- 2026-09-02 · Balance is -10\n- 2026-09-03 · Balance is 10\n";
    const plan = planTidy(small, TODAY, [{ a: 0, b: 1, keep: "b" }]);
    expect(plan.superseded).toEqual([]);
    expect(plan.deferred).toBe(1);
  });

  it("strikes the loser of a contradiction with a date, never deletes it", () => {
    const text = ["- 2026-09-01 · Office is in Pune", "- 2026-09-02 · Likes tea", "- 2026-09-03 · Has a dog", "- 2026-09-04 · Drives a Honda", "- 2026-09-10 · Office is in Mumbai"].join("\n");
    const candidates = contradictionCandidates(text, TODAY);
    expect(candidates).toHaveLength(5);
    const plan = planTidy(text, TODAY, parseContradictions('{"pairs":[{"a":0,"b":4,"keep":"b"},{"a":1,"b":2,"keep":"a"}]}', candidates.length));
    expect(plan.superseded).toHaveLength(1);
    expect(plan.deferred).toBe(1);
    const next = applyTidy(text, plan, TODAY).text;
    expect(next.split("\n")[0]).toBe("- 2026-09-01 · ~~Office is in Pune~~ · superseded 2026-09-25");
    expect(next).toContain("Office is in Mumbai");
  });

  it("keeps the still-true part of a line that held two facts", () => {
    const text = ["- 2026-09-01 · Lives in Pune and prefers short replies", "- 2026-09-02 · Likes tea", "- 2026-09-03 · Has a dog", "- 2026-09-04 · Drives a Honda", "- 2026-09-10 · Moved to Mumbai"].join("\n");
    const pairs = parseContradictions('{"pairs":[{"a":0,"b":4,"keep":"b","remainder":"Prefers short replies"}]}', 5);
    const next = applyTidy(text, planTidy(text, TODAY, pairs), TODAY).text.split("\n");
    expect(next[0]).toBe("- 2026-09-01 · ~~Lives in Pune and prefers short replies~~ · superseded 2026-09-25");
    expect(next[1]).toBe("- 2026-09-25 · from tidy-up · Prefers short replies");
  });

  it("ignores malformed or out-of-range contradiction answers", () => {
    expect(parseContradictions("nope", 3)).toEqual([]);
    expect(parseContradictions('{"pairs":[{"a":0,"b":0,"keep":"a"},{"a":0,"b":9,"keep":"a"},{"a":1,"b":2,"keep":"x"},{"a":2,"b":1,"keep":"b"},{"a":1,"b":2,"keep":"a"}]}', 3)).toEqual([
      { a: 2, b: 1, keep: "b" },
    ]);
  });
});

describe("About me suggestions", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("adds new facts once, skips what About me says, and remembers a dismissal", () => {
    const from = { botId: "b1", botName: "Scout" };
    const added = suggestProfileFacts(from, ["Is vegetarian", "Lives in Pune", "Is vegetarian"], "- 2026-09-01 · learned by Scout · Lives in Pune");
    expect(added.map((s) => s.text)).toEqual(["Is vegetarian"]);
    expect(suggestProfileFacts(from, ["Is vegetarian"], "")).toEqual([]);
    expect(resolveProfileSuggestion(added[0]!.id, "dismiss")?.text).toBe("Is vegetarian");
    expect(listProfileSuggestions()).toEqual([]);
    expect(suggestProfileFacts(from, ["Is vegetarian"], "")).toEqual([]);
    expect(suggestProfileFacts(from, ["api_key: sk-abcdefghijklmnopqrstuvwxyz123456"], "")[0]?.text).not.toContain("sk-abcdefghijklmnop");
  });

  it("formats and bounds the About me line", () => {
    const line = aboutMeLine({ id: "x", text: "Is vegetarian", botId: "b", botName: "Scout · Bot", at: 0 }, TODAY);
    expect(line).toBe("- 2026-09-25 · learned by Scout - Bot · Is vegetarian");
    expect(appendAboutMe("I run a studio.\n\n", line)).toBe(`I run a studio.\n${line}`);
    expect(appendAboutMe("", line)).toBe(line);
    expect(appendAboutMe("x".repeat(24_000), line)).toBeNull();
  });
});

describe("the upkeep loop", () => {
  const BOT: UpkeepBot = { id: "bot-upkeep-test", name: "Scout", memoryUpkeep: true };
  let answers: string[];
  let prompts: string[];
  let engine: UpkeepEngine | null;
  let busy: boolean;
  let clock: Date;

  const upkeep = () => createMemoryUpkeep({
    bots: () => [BOT],
    bot: (id) => (id === BOT.id ? BOT : undefined),
    engine: () => engine,
    busy: () => busy,
    aboutMe: () => "",
    sourceLabel: () => 'chat "Plans"',
    quietMs: () => 60_000,
    tidyHour: () => 3,
    now: () => clock,
  });

  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
    answers = [];
    prompts = [];
    busy = false;
    BOT.memoryUpkeep = true;
    clock = new Date(2026, 8, 25, 10, 0);
    engine = {
      generateText: async (prompt) => {
        prompts.push(prompt);
        return answers.shift() ?? "[]";
      },
    };
  });

  const memory = () => readFileSync(join(workspaceDir(BOT.id), "MEMORY.md"), "utf8");

  it("captures new facts as dated, sourced entries, journaled as upkeep, and suggests About me lines", async () => {
    ensureWorkspace(BOT.id);
    answers.push(JSON.stringify([
      { text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 },
      { text: "The person has exams this weekend", kind: "fact", until: "2026-09-27", confidence: 0.9 },
    ]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "I'm vegetarian and I have exams this weekend", bot: "Good luck!" }] });
    expect(report).toMatchObject({ added: 2, suggested: 1 });
    expect(memory()).toContain('- 2026-09-25 · from chat "Plans" (noticed) · The person is vegetarian\n');
    expect(memory()).toContain("The person has exams this weekend · until 2026-09-27");
    await flushMemoryJournal(BOT.id);
    expect(readMemoryJournal(BOT.id, 5)[0]).toMatchObject({ actor: "upkeep", via: "capture", threadId: "t1", path: "MEMORY.md" });
    expect(listProfileSuggestions().map((s) => s.text)).toEqual(["The person is vegetarian"]);
  });

  it("suggests a fact the notebook already holds, without appending it again", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-25 · The user's company is called Northwind Studio.\n");
    answers.push(JSON.stringify([{ text: "The user's company is Northwind Studio", kind: "fact", aboutUser: true, noted: true }]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "My company is Northwind Studio", bot: "Noted." }] });
    expect(report).toMatchObject({ added: 0, suggested: 1 });
    expect(memory().match(/Northwind/g)).toHaveLength(1);
  });

  it("does not suggest About me lines from another person's message", async () => {
    answers.push(JSON.stringify([{ text: "Is vegetarian", kind: "preference", aboutUser: true }]));
    const report = await upkeep().capture({ botId: BOT.id, threadId: "t1", turns: [{ person: "I'm vegetarian", bot: "ok", owner: false }] });
    expect(report).toMatchObject({ added: 1, suggested: 0 });
  });

  it("does nothing when the switch is off, and says so on an engine without a text call", async () => {
    BOT.memoryUpkeep = false;
    expect((await upkeep().capture({ botId: BOT.id, threadId: "t", turns: [{ person: "x", bot: "y" }] })).note).toBe("upkeep is off");
    BOT.memoryUpkeep = true;
    engine = {};
    expect((await upkeep().capture({ botId: BOT.id, threadId: "t", turns: [{ person: "x", bot: "y" }] })).note).toBe(NO_TEXT_ENGINE);
    expect(prompts).toEqual([]);
  });

  it("tidies: archives the expired, merges duplicates, strikes a contradiction, all undoable rows", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, [
      "- 2026-09-01 · Exams this weekend · until 2026-09-07",
      "- 2026-09-02 · Office is in Pune",
      "- 2026-09-03 · Likes tea",
      "- 2026-09-04 · Likes tea",
      "- 2026-09-05 · Has a dog",
      "- 2026-09-06 · Drives a Honda",
      "- 2026-09-07 · Plays chess",
      "- 2026-09-20 · Office is in Mumbai",
      "",
    ].join("\n"));
    // candidates after expiry and dedupe: Pune[0], tea[1], dog[2], Honda[3], chess[4], Mumbai[5]
    answers.push('{"pairs":[{"a":0,"b":5,"keep":"b"}]}');
    const report = await upkeep().tidy(BOT.id);
    expect(report).toMatchObject({ expired: 1, duplicates: 1, superseded: 1, contradictionsChecked: true });
    expect(prompts[0]).toContain("[5] (2026-09-20) Office is in Mumbai");
    const text = memory();
    expect(text).not.toContain("Exams this weekend");
    expect(text).toContain("~~Office is in Pune~~ · superseded 2026-09-25");
    expect(text.match(/Likes tea/g)).toHaveLength(1);
    expect(readMemoryTopic(BOT.id, "archive.md")).toContain("Exams this weekend · until 2026-09-07 · expired 2026-09-25");
    await flushMemoryJournal(BOT.id);
    const rows = readMemoryJournal(BOT.id, 10);
    expect(rows.filter((row) => row.actor === "upkeep" && row.via === "tidy").map((row) => row.path)).toEqual(["MEMORY.md", "memory/archive.md"]);
    // newest first: undoing the top row puts MEMORY.md back, and the archive keeps its copy
    expect(rows[0]!.path).toBe("MEMORY.md");
  });

  it("skips the model step on small notebooks and on engines without a text call", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-02 · Balance is -10\n- 2026-09-03 · Balance is 10\n");
    const report = await upkeep().tidy(BOT.id);
    expect(report.contradictionsChecked).toBe(false);
    expect(prompts).toEqual([]);
    expect(memory()).toContain("Balance is -10");
    expect(memory()).toContain("Balance is 10");
    engine = null;
    expect((await upkeep().tidy(BOT.id)).note).toBe(NO_TEXT_ENGINE);
  });

  it("runs the nightly tidy once a day after the hour, never while the bot is busy", async () => {
    ensureWorkspace(BOT.id);
    writeMemoryFile(BOT.id, "- 2026-09-01 · Trip · until 2026-09-02\n");
    const loop = upkeep();
    clock = new Date(2026, 8, 25, 2, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
    clock = new Date(2026, 8, 25, 4, 0);
    busy = true;
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy).toBeUndefined();
    busy = false;
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.expired).toBe(1);
    const first = loop.status(BOT.id).lastTidy?.at;
    clock = new Date(2026, 8, 25, 23, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.at).toBe(first);
    clock = new Date(2026, 8, 26, 9, 0);
    await loop.tick();
    expect(loop.status(BOT.id).lastTidy?.at).not.toBe(first);
  });

  it("defers capture while paused for a backup and runs it on resume", async () => {
    const loop = upkeep();
    answers.push(JSON.stringify([{ text: "Likes jazz", kind: "preference" }]));
    loop.pause();
    loop.noteTurn(BOT.id, "t1", { person: "I like jazz", bot: "Nice" });
    loop.flushThread("t1");
    await loop.idle();
    expect(prompts).toEqual([]);
    loop.resume();
    await loop.idle();
    expect(memory()).toContain("Likes jazz");
  });
});
