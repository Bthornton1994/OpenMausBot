import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POINTER_BODY, checkSource, syncSkill } from "./skill-sync.mjs";

const dirs = [];
function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sync-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const status = (report) => report.adapters.map((a) => a.status);
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("skill-sync", () => {
  it("keeps the manifest hash in step with the canonical skill", () => {
    expect(checkSource().ok).toBe(true);
  });

  it("dry run reports and writes nothing", () => {
    const dir = repo({ ".claude/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    const report = syncSkill({ target: dir });
    expect(status(report)).toEqual(["CREATE"]);
    expect(fs.existsSync(path.join(dir, ".claude/skills/product-discovery-build"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# a\n");
  });

  it("applies once, stamps provenance, and is idempotent", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x", ".claude/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    syncSkill({ target: dir, apply: true, sourceRef: "abc123" });
    const prov = JSON.parse(fs.readFileSync(path.join(dir, ".claude/skills/product-discovery-build/PROVENANCE.json"), "utf8"));
    expect(prov.source.ref).toBe("abc123");
    expect(prov.host).toBe("claude");
    const before = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(before).toContain(POINTER_BODY);
    const second = syncSkill({ target: dir, apply: true, sourceRef: "abc123" });
    expect(status(second)).toEqual(["UP-TO-DATE", "UP-TO-DATE"]);
    expect(second.pointer.status).toBe("UP-TO-DATE");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("does not clobber an unmanaged or locally edited copy", () => {
    const dir = repo({ ".claude/skills/product-discovery-build/SKILL.md": "mine", ".agents/skills/other/SKILL.md": "x" });
    let report = syncSkill({ target: dir, apply: true });
    expect(status(report)).toEqual(["CREATE", "COLLISION"]);
    expect(report.collisions).toBe(1);
    expect(fs.readFileSync(path.join(dir, ".claude/skills/product-discovery-build/SKILL.md"), "utf8")).toBe("mine");
    syncSkill({ target: dir, hosts: ["grok"], apply: true });
    fs.appendFileSync(path.join(dir, ".grok/skills/product-discovery-build/SKILL.md"), "\nlocal edit\n");
    report = syncSkill({ target: dir, hosts: ["grok"], apply: true, updateStale: true });
    expect(status(report)).toEqual(["MODIFIED"]);
  });

  it("reports a stale copy and replaces it only with updateStale", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x" });
    syncSkill({ target: dir, apply: true });
    const provFile = path.join(dir, ".agents/skills/product-discovery-build/PROVENANCE.json");
    const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
    prov.canonicalSha256 = "0".repeat(64);
    fs.writeFileSync(provFile, JSON.stringify(prov));
    expect(status(syncSkill({ target: dir, apply: true }))).toEqual(["STALE"]);
    expect(JSON.parse(fs.readFileSync(provFile, "utf8")).canonicalSha256).toBe("0".repeat(64));
    expect(syncSkill({ target: dir, apply: true, updateStale: true }).adapters[0].written).toBe(true);
    expect(status(syncSkill({ target: dir }))).toEqual(["UP-TO-DATE"]);
  });

  it("treats CRLF checkouts as unmodified and skips the pointer without AGENTS.md", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x" });
    expect(syncSkill({ target: dir, apply: true }).pointer.status).toBe("SKIPPED");
    const skill = path.join(dir, ".agents/skills/product-discovery-build/SKILL.md");
    fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replace(/\n/g, "\r\n"));
    expect(status(syncSkill({ target: dir }))).toEqual(["UP-TO-DATE"]);
  });
});
