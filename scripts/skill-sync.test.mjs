import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkSource, pointerBody, syncSkill, syncSkills } from "./skill-sync.mjs";

const PDB = "product-discovery-build";
const GATE = "universal-pre-launch-gate";
const SHARED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "standards", "shared-skills");

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
// Every file under dir, keyed by relative path, so before/after trees can be compared byte for byte.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}
// A scratch copy of the canonical skills, for tests that alter the source.
function sharedCopy() {
  const dir = repo();
  fs.cpSync(SHARED_ROOT, dir, { recursive: true });
  return dir;
}
const status = (report) => report.adapters.map((a) => a.status);
const count = (text, needle) => text.split(needle).length - 1;
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("skill-sync", () => {
  it("keeps the manifest hash in step with every canonical skill", () => {
    const results = checkSource();
    expect(results.map((r) => r.skill)).toEqual([PDB, GATE]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("dry run reports and writes nothing", () => {
    const dir = repo({ ".claude/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    const report = syncSkill({ skill: PDB, target: dir });
    expect(status(report)).toEqual(["CREATE"]);
    expect(fs.existsSync(path.join(dir, ".claude/skills/product-discovery-build"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("# a\n");
  });

  it("applies once, stamps provenance, and is idempotent", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x", ".claude/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    syncSkill({ skill: PDB, target: dir, apply: true, sourceRef: "abc123" });
    const prov = JSON.parse(fs.readFileSync(path.join(dir, ".claude/skills/product-discovery-build/PROVENANCE.json"), "utf8"));
    expect(prov.source.ref).toBe("abc123");
    expect(prov.host).toBeUndefined();
    const agentsProv = fs.readFileSync(path.join(dir, ".agents/skills/product-discovery-build/PROVENANCE.json"), "utf8");
    expect(agentsProv).toBe(fs.readFileSync(path.join(dir, ".claude/skills/product-discovery-build/PROVENANCE.json"), "utf8"));
    const before = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(before).toContain(pointerBody(PDB));
    const second = syncSkill({ skill: PDB, target: dir, apply: true, sourceRef: "abc123" });
    expect(status(second)).toEqual(["UP-TO-DATE", "UP-TO-DATE"]);
    expect(second.pointer.status).toBe("UP-TO-DATE");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  it("does not clobber an unmanaged or locally edited copy", () => {
    const dir = repo({ ".claude/skills/product-discovery-build/SKILL.md": "mine", ".agents/skills/other/SKILL.md": "x" });
    let report = syncSkill({ skill: PDB, target: dir, apply: true });
    expect(status(report)).toEqual(["CREATE", "COLLISION"]);
    expect(report.collisions).toBe(1);
    expect(fs.readFileSync(path.join(dir, ".claude/skills/product-discovery-build/SKILL.md"), "utf8")).toBe("mine");
    syncSkill({ skill: PDB, target: dir, hosts: ["grok"], apply: true });
    fs.appendFileSync(path.join(dir, ".grok/skills/product-discovery-build/SKILL.md"), "\nlocal edit\n");
    report = syncSkill({ skill: PDB, target: dir, hosts: ["grok"], apply: true, updateStale: true });
    expect(status(report)).toEqual(["MODIFIED"]);
  });

  it("reports a stale copy and replaces it only with updateStale", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x" });
    syncSkill({ skill: PDB, target: dir, apply: true });
    const provFile = path.join(dir, ".agents/skills/product-discovery-build/PROVENANCE.json");
    const prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
    prov.canonicalSha256 = "0".repeat(64);
    fs.writeFileSync(provFile, JSON.stringify(prov));
    expect(status(syncSkill({ skill: PDB, target: dir, apply: true }))).toEqual(["STALE"]);
    expect(JSON.parse(fs.readFileSync(provFile, "utf8")).canonicalSha256).toBe("0".repeat(64));
    expect(syncSkill({ skill: PDB, target: dir, apply: true, updateStale: true }).adapters[0].written).toBe(true);
    expect(status(syncSkill({ skill: PDB, target: dir }))).toEqual(["UP-TO-DATE"]);
  });

  it("treats CRLF checkouts as unmodified and skips the pointer without AGENTS.md", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x" });
    expect(syncSkill({ skill: PDB, target: dir, apply: true }).pointer.status).toBe("SKIPPED");
    const skill = path.join(dir, ".agents/skills/product-discovery-build/SKILL.md");
    fs.writeFileSync(skill, fs.readFileSync(skill, "utf8").replace(/\n/g, "\r\n"));
    expect(status(syncSkill({ skill: PDB, target: dir }))).toEqual(["UP-TO-DATE"]);
  });
});

describe("skill-sync with several skills", () => {
  it("keeps the product-discovery-build pointer text from the single-skill release", () => {
    // sha256 of the pointer body written by the single-skill script at b2c725af; existing targets must stay UP-TO-DATE.
    expect(createHash("sha256").update(pointerBody(PDB)).digest("hex")).toBe("e089002f5fd06bdcda4ab9392bbc3f4c6b883042d0552d492009779380fa20e1");
  });

  it("syncs every manifest skill by default, one pointer block each, and a second apply changes nothing", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x", ".claude/skills/other/SKILL.md": "x", "AGENTS.md": "# a\r\n" });
    const first = syncSkills({ target: dir, apply: true, sourceRef: "abc123" });
    expect(first.map((r) => [r.skill, status(r), r.pointer.status])).toEqual([
      [PDB, ["CREATE", "CREATE"], "CREATE"],
      [GATE, ["CREATE", "CREATE"], "CREATE"],
    ]);
    const prov = JSON.parse(fs.readFileSync(path.join(dir, ".claude/skills/universal-pre-launch-gate/PROVENANCE.json"), "utf8"));
    expect(prov).toMatchObject({ skill: GATE, source: { path: `standards/shared-skills/${GATE}`, ref: "abc123" } });
    expect(Object.keys(prov.files)).toContain("references/core-checklist.md");
    const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(count(agents, `BEGIN POINTER: ${PDB} `)).toBe(1);
    expect(count(agents, `BEGIN POINTER: ${GATE} `)).toBe(1);

    const before = snapshot(dir);
    const second = syncSkills({ target: dir, apply: true, sourceRef: "abc123" });
    expect(second.flatMap((r) => [...status(r), r.pointer.status])).toEqual(Array(6).fill("UP-TO-DATE"));
    expect(snapshot(dir)).toEqual(before);
  });

  it("leaves an existing product-discovery-build adapter and pointer byte-identical when the gate is added", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    syncSkill({ skill: PDB, target: dir, apply: true, sourceRef: "abc123" });
    const pdbBefore = snapshot(path.join(dir, ".agents/skills", PDB));
    const agentsBefore = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    const reports = syncSkills({ target: dir, apply: true, sourceRef: "def456" });
    expect(reports.map((r) => [r.skill, status(r), r.pointer.status])).toEqual([
      [PDB, ["UP-TO-DATE"], "UP-TO-DATE"],
      [GATE, ["CREATE"], "CREATE"],
    ]);
    expect(snapshot(path.join(dir, ".agents/skills", PDB))).toEqual(pdbBefore);
    const agentsAfter = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(agentsAfter.startsWith(agentsBefore)).toBe(true);
    expect(agentsAfter.slice(agentsBefore.length)).toContain(pointerBody(GATE));
  });

  it("dry run over several skills and existing destinations writes nothing", () => {
    const dir = repo({ ".claude/skills/other/SKILL.md": "x", ".claude/skills/universal-pre-launch-gate/SKILL.md": "mine", "AGENTS.md": "# a\n" });
    syncSkill({ skill: PDB, target: dir, hosts: ["agents"], apply: true });
    const before = snapshot(dir);
    const reports = syncSkills({ target: dir, hosts: ["agents", "claude"], updateStale: true });
    expect(reports.map(status)).toEqual([
      ["UP-TO-DATE", "CREATE"],
      ["CREATE", "COLLISION"],
    ]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("isolates a foreign, modified or stale gate adapter from the other skill", () => {
    const dir = repo({ ".claude/skills/universal-pre-launch-gate/SKILL.md": "mine", ".agents/skills/other/SKILL.md": "x", ".grok/skills/other/SKILL.md": "x" });
    let reports = syncSkills({ target: dir, apply: true });
    expect(reports.map((r) => [r.skill, status(r), r.collisions])).toEqual([
      [PDB, ["CREATE", "CREATE", "CREATE"], 0],
      [GATE, ["CREATE", "COLLISION", "CREATE"], 1],
    ]);
    expect(fs.readFileSync(path.join(dir, ".claude/skills/universal-pre-launch-gate/SKILL.md"), "utf8")).toBe("mine");
    expect(fs.existsSync(path.join(dir, ".claude/skills/product-discovery-build/PROVENANCE.json"))).toBe(true);

    fs.appendFileSync(path.join(dir, ".agents/skills/universal-pre-launch-gate/SKILL.md"), "\nlocal edit\n");
    const provFile = path.join(dir, ".grok/skills/universal-pre-launch-gate/PROVENANCE.json");
    fs.writeFileSync(provFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(provFile, "utf8")), canonicalSha256: "0".repeat(64) }));
    const edited = fs.readFileSync(path.join(dir, ".agents/skills/universal-pre-launch-gate/SKILL.md"), "utf8");

    reports = syncSkills({ target: dir, apply: true });
    expect(reports.map(status)).toEqual([
      ["UP-TO-DATE", "UP-TO-DATE", "UP-TO-DATE"],
      ["MODIFIED", "COLLISION", "STALE"],
    ]);
    expect(reports[1].stale).toBe(1);
    reports = syncSkills({ target: dir, skills: [GATE], apply: true, updateStale: true });
    expect(status(reports[0])).toEqual(["MODIFIED", "COLLISION", "STALE"]);
    expect(reports[0].adapters[2].written).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".agents/skills/universal-pre-launch-gate/SKILL.md"), "utf8")).toBe(edited);
  });

  it("rejects invalid and unknown skill names before writing anything", () => {
    const dir = repo({ ".agents/skills/other/SKILL.md": "x", "AGENTS.md": "# a\n" });
    const before = snapshot(dir);
    for (const name of ["../x", "..", "a/b", "a\\b", "/etc", "C:\\x", "C:", "", "A", "a--b", "-a", "a.b", "a b", "x".repeat(65)]) {
      expect(() => syncSkills({ target: dir, skills: [PDB, name], apply: true }), name).toThrow(/Invalid skill name/);
    }
    expect(() => syncSkills({ target: dir, skills: [PDB, "nope"], apply: true })).toThrow(/Unknown skill "nope"/);
    expect(snapshot(dir)).toEqual(before);

    const root = sharedCopy();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    manifest.skills["../escape"] = manifest.skills[GATE];
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    expect(() => syncSkills({ target: dir, root })).toThrow(/Invalid skill name/);
  });

  it("detects a manifest hash mismatch for the gate without flagging the other skill", () => {
    const root = sharedCopy();
    fs.appendFileSync(path.join(root, GATE, "references/core-checklist.md"), "\n| 21 | Extra | Universal | none |\n");
    expect(checkSource({ root }).map((r) => [r.skill, r.ok])).toEqual([
      [PDB, true],
      [GATE, false],
    ]);
  });

  it("keeps pointer blocks of skills whose names share a prefix apart", () => {
    const root = sharedCopy();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    fs.cpSync(path.join(root, GATE), path.join(root, `${GATE}-lite`), { recursive: true });
    manifest.skills[`${GATE}-lite`] = { ...manifest.skills[GATE], pointer: "## Lite\n\nlite pointer" };
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
    const dir = repo({ "AGENTS.md": "# a\n" });
    syncSkills({ target: dir, root, skills: [`${GATE}-lite`], apply: true });
    expect(syncSkill({ target: dir, root, skill: GATE }).pointer.status).toBe("CREATE");
    syncSkills({ target: dir, root, apply: true });
    expect(syncSkills({ target: dir, root }).map((r) => r.pointer.status)).toEqual(["UP-TO-DATE", "UP-TO-DATE", "UP-TO-DATE"]);
  });
});
