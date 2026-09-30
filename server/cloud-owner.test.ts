import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { settleCloudOwnership, type PeopleRecord } from "./cloud-owner.ts";
import { ThreadStarters } from "./thread-starters.ts";

const key = (name: string) => `p_${name.padEnd(22, "x")}`;
const OWNER = key("owner"), NOBODY = key("nobody");
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

/** Sessions as the registry lists them; revoke removes one. */
function sessionsOf(list: { id: string; scopes: string[] }[]) {
  const live = [...list];
  return {
    list: () => live,
    revoke: (id: string) => { const at = live.findIndex((session) => session.id === id); if (at < 0) return false; live.splice(at, 1); return true; },
  };
}
const writersOf = (writers: Record<string, string>): PeopleRecord & { writers: Record<string, string> } => ({
  writers,
  people: () => new Set(Object.values(writers)),
  reassign(move, to) { let moved = 0; for (const [id, person] of Object.entries(writers)) if (person !== to && move(person)) { writers[id] = to; moved += 1; } return moved; },
});

describe("a Cloud home is personal (server/cloud-owner.ts)", () => {
  it("revokes every session without admin scope, and makes what those opened nobody's; everything from before is the owner's, once", () => {
    dir = mkdtempSync(join(tmpdir(), "omb-cloud-owner-"));
    writeFileSync(join(dir, "thread-starters.json"), JSON.stringify({
      laptop: key("laptop"), phone: key("phone"), gone: key("gone"), guest: key("guest"), nobody: NOBODY, owner: OWNER,
    }));
    const starters = new ThreadStarters(join(dir, "thread-starters.json"));
    const writers = writersOf({ mine: key("laptop"), theirs: key("guest"), old: key("gone") });
    const sessions = sessionsOf([{ id: "laptop", scopes: ["admin", "client"] }, { id: "guest", scopes: ["client"] }]);
    const lines: string[] = [];
    const settle = () => settleCloudOwnership({
      file: join(dir, "cloud-owner.json"), sessions, personKey: (session) => key(session.id), starters, writers,
      ownerKey: OWNER, nobodyKey: NOBODY, log: (line) => lines.push(line),
    });
    const earlier = settle();
    expect(sessions.list().map((session) => session.id)).toEqual(["laptop"]);
    expect(lines[0]).toBe("cloud home: revoked 1 session that was not the owner's own device");
    // The revoked session's conversation and routine are nobody's; the rest
    // (a paired device, one unpaired since) the owner's.
    expect(starters.get("guest")).toBe(NOBODY);
    expect(starters.get("nobody")).toBe(NOBODY);
    for (const thread of ["laptop", "phone", "gone", "owner"]) expect(starters.get(thread), thread).toBe(OWNER);
    expect(writers.writers).toEqual({ mine: OWNER, theirs: NOBODY, old: OWNER });
    expect([...earlier].sort()).toEqual([key("gone"), key("laptop"), key("phone")]);
    expect(lines.join("\n")).not.toContain("guest");
    // Later boots only revoke; what was settled stays settled.
    sessions.list().push({ id: "late", scopes: ["client"] });
    expect(JSON.parse(readFileSync(join(dir, "cloud-owner.json"), "utf8")).ownerKeys).toHaveLength(3);
    const again = settle();
    expect(sessions.list().map((session) => session.id)).toEqual(["laptop"]);
    expect([...again].sort()).toEqual([...earlier].sort());
  });
  it("an unreadable record makes nothing from before the owner's, and is not run again", () => {
    dir = mkdtempSync(join(tmpdir(), "omb-cloud-owner-"));
    writeFileSync(join(dir, "cloud-owner.json"), "{broken");
    writeFileSync(join(dir, "thread-starters.json"), JSON.stringify({ laptop: key("laptop") }));
    const starters = new ThreadStarters(join(dir, "thread-starters.json"));
    const lines: string[] = [];
    const earlier = settleCloudOwnership({
      file: join(dir, "cloud-owner.json"), sessions: sessionsOf([]), personKey: (session) => key(session.id), starters, writers: writersOf({}),
      ownerKey: OWNER, nobodyKey: NOBODY, log: (line) => lines.push(line),
    });
    expect(earlier.size).toBe(0);
    expect(starters.get("laptop")).toBe(key("laptop"));
    expect(lines.at(-1)).toContain("unreadable");
  });
});
