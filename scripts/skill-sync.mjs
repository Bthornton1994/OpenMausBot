// Generates provenance-tracked host adapters of shared skills into another
// repository. Each canonical skill lives in standards/shared-skills/<name>/,
// is listed in standards/shared-skills/manifest.json, and is never edited in a
// target repo: a target copy is an adapter, stamped with PROVENANCE.json so
// drift is detectable.
//
//   node scripts/skill-sync.mjs --target <repo> [--skills a,b] [--hosts agents,claude,grok]
//        [--source-ref <sha>] [--apply] [--update-stale] [--json]
//   node scripts/skill-sync.mjs --check-source [--skills a,b]     (manifest matches canonical)
//   node scripts/skill-sync.mjs --write-manifest [--skills a,b]   (refresh the manifest)
//
// --skills defaults to every skill in the manifest. Dry run is the default.
// Nothing is written without --apply, an existing directory without
// PROVENANCE.json is never touched (collision), a copy whose files were edited
// after generation is never touched (modified), and a copy from an older
// canonical version is replaced only with --update-stale.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = path.resolve(HERE, "..", "standards", "shared-skills");
export const SOURCE_REPO = "Bthornton1994/OpenMausBot";
export const HOST_DIRS = {
  agents: ".agents/skills",
  claude: ".claude/skills",
  grok: ".grok/skills",
  cursor: ".cursor/skills",
};
export const POINTER_FILE = "AGENTS.md";
const PROVENANCE_FILE = "PROVENANCE.json";
// A skill name becomes a folder name under every host root, so it is limited to
// lowercase words joined by single hyphens: no separators, dots, or drive letters.
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POINTER_BEGIN = (name, hash) => `<!-- BEGIN POINTER: ${name} (skill-sync sha256:${hash}) -->`;
const POINTER_END = (name) => `<!-- END POINTER: ${name} -->`;

export function validateSkillName(name) {
  if (typeof name !== "string" || name.length > 64 || !SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name ${JSON.stringify(name)}; use lowercase letters, digits and single hyphens (max 64)`);
  }
  return name;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// Line endings differ by checkout, so compare content with LF endings.
const normalized = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const fileHash = (file) => sha256(normalized(fs.readFileSync(file)));

function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
    })
    .sort();
}

export function canonicalDir(skill, root = SHARED_ROOT) {
  return path.join(root, validateSkillName(skill));
}

export function hashTree(dir, exclude = PROVENANCE_FILE) {
  const files = {};
  for (const rel of listFiles(dir)) {
    if (rel !== exclude) files[rel] = fileHash(path.join(dir, rel));
  }
  return { files, contentSha256: sha256(JSON.stringify(files)) };
}

export function readManifest(root = SHARED_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  for (const name of Object.keys(manifest.skills ?? {})) validateSkillName(name);
  return manifest;
}

// Resolves the requested skill names (default: every manifest skill) and rejects
// invalid or unknown names before anything is read from or written to disk.
export function selectSkills(skills, root = SHARED_ROOT) {
  const known = Object.keys(readManifest(root).skills);
  const selected = skills ?? known;
  if (selected.length === 0) throw new Error("No skills selected");
  for (const name of selected) {
    validateSkillName(name);
    if (!known.includes(name)) throw new Error(`Unknown skill "${name}"; known: ${known.join(", ")}`);
  }
  return [...new Set(selected)];
}

export function pointerBody(skill, root = SHARED_ROOT) {
  const body = readManifest(root).skills[skill]?.pointer;
  if (typeof body !== "string" || body.trim() === "") throw new Error(`manifest.json skill "${skill}" has no pointer text`);
  return body;
}

export function writeManifest({ skills, root = SHARED_ROOT } = {}) {
  const manifest = readManifest(root);
  for (const name of selectSkills(skills, root)) {
    manifest.skills[name].contentSha256 = hashTree(canonicalDir(name, root)).contentSha256;
  }
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function checkSource({ skills, root = SHARED_ROOT } = {}) {
  const manifest = readManifest(root);
  return selectSkills(skills, root).map((skill) => {
    const expected = manifest.skills[skill].contentSha256;
    const actual = hashTree(canonicalDir(skill, root)).contentSha256;
    return { skill, ok: expected === actual, expected, actual };
  });
}

function classifyAdapter(adapterDir, canonical) {
  if (!fs.existsSync(adapterDir)) return { status: "CREATE" };
  const provFile = path.join(adapterDir, PROVENANCE_FILE);
  if (!fs.existsSync(provFile)) return { status: "COLLISION", detail: "directory exists without PROVENANCE.json; not generated by skill-sync" };
  let prov;
  try {
    prov = JSON.parse(fs.readFileSync(provFile, "utf8"));
  } catch {
    return { status: "COLLISION", detail: "unreadable PROVENANCE.json" };
  }
  const present = hashTree(adapterDir).files;
  const recorded = prov.files ?? {};
  const edited = [...new Set([...Object.keys(present), ...Object.keys(recorded)])].filter((f) => present[f] !== recorded[f]);
  if (edited.length > 0) return { status: "MODIFIED", detail: `edited since generation: ${edited.join(", ")}` };
  if (prov.canonicalSha256 === canonical.contentSha256) return { status: "UP-TO-DATE" };
  return { status: "STALE", detail: `generated from ${prov.version ?? "?"} (${String(prov.canonicalSha256).slice(0, 12)}), canonical is ${canonical.contentSha256.slice(0, 12)}` };
}

function writeAdapter(skill, adapterDir, canonical, canonicalPath, version, sourceRef) {
  fs.rmSync(adapterDir, { recursive: true, force: true });
  for (const rel of Object.keys(canonical.files)) {
    const dest = path.join(adapterDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, normalized(fs.readFileSync(path.join(canonicalPath, rel))));
  }
  const provenance = {
    generator: "scripts/skill-sync.mjs",
    skill,
    version,
    canonicalSha256: canonical.contentSha256,
    source: { repo: SOURCE_REPO, path: `standards/shared-skills/${skill}`, ref: sourceRef },
    files: canonical.files,
    notice: "Generated adapter. Do not edit; change the canonical skill and re-run skill-sync.",
  };
  fs.writeFileSync(path.join(adapterDir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
}

function pointerBlock(skill, body, eol) {
  return [POINTER_BEGIN(skill, sha256(body)), body, POINTER_END(skill)].join(eol);
}

// Each skill owns one block delimited by its own markers. The name is followed
// by a space or " -->", so one skill's markers never match a longer name.
function classifyPointer(text, skill, body) {
  const begin = new RegExp(`<!-- BEGIN POINTER: ${skill} \\(skill-sync sha256:([0-9a-f]{64})\\) -->`).exec(text);
  if (!begin) return { status: text.includes(`BEGIN POINTER: ${skill} `) ? "COLLISION" : "CREATE" };
  const endIdx = text.indexOf(POINTER_END(skill), begin.index);
  if (endIdx < 0) return { status: "COLLISION", detail: "pointer end marker missing" };
  const bodyStart = begin.index + begin[0].length;
  const current = text.slice(bodyStart, endIdx).replace(/\r\n/g, "\n").trim();
  if (sha256(current) !== begin[1]) return { status: "MODIFIED", detail: "pointer body edited since generation" };
  if (begin[1] === sha256(body)) return { status: "UP-TO-DATE" };
  return { status: "STALE", detail: "pointer text from an older skill-sync version", begin, endIdx };
}

export function syncSkill({ skill, target, hosts, apply = false, updateStale = false, sourceRef = "unspecified", root = SHARED_ROOT }) {
  [skill] = selectSkills([skill], root);
  const canonicalPath = canonicalDir(skill, root);
  const canonical = hashTree(canonicalPath);
  const version = readManifest(root).skills[skill].version;
  const body = pointerBody(skill, root);
  const report = { target: path.resolve(target), skill, version, canonicalSha256: canonical.contentSha256, sourceRef, applied: apply, adapters: [], pointer: null, unmanaged: [] };

  const selected = hosts ?? Object.keys(HOST_DIRS).filter((h) => fs.existsSync(path.join(target, HOST_DIRS[h])));
  for (const host of selected) {
    if (!HOST_DIRS[host]) throw new Error(`Unknown host "${host}"; known: ${Object.keys(HOST_DIRS).join(", ")}`);
    const rel = `${HOST_DIRS[host]}/${skill}`;
    const adapterDir = path.join(target, rel);
    const result = { host, path: rel, ...classifyAdapter(adapterDir, canonical) };
    const writes = result.status === "CREATE" || (result.status === "STALE" && updateStale);
    if (apply && writes) {
      writeAdapter(skill, adapterDir, canonical, canonicalPath, version, sourceRef);
      result.written = true;
    }
    report.adapters.push(result);
  }
  // Copies of the skill in host folders this run did not select are reported, never touched.
  for (const [host, dir] of Object.entries(HOST_DIRS)) {
    if (!selected.includes(host) && fs.existsSync(path.join(target, dir, skill))) report.unmanaged.push(`${dir}/${skill}`);
  }

  const pointerPath = path.join(target, POINTER_FILE);
  if (!fs.existsSync(pointerPath)) {
    report.pointer = { file: POINTER_FILE, status: "SKIPPED", detail: `${POINTER_FILE} not found; no pointer written` };
  } else {
    const text = fs.readFileSync(pointerPath, "utf8");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const result = { file: POINTER_FILE, ...classifyPointer(text, skill, body) };
    if (apply && result.status === "CREATE") {
      const sep = text.endsWith(eol) ? eol : eol + eol;
      fs.writeFileSync(pointerPath, `${text}${sep}${pointerBlock(skill, body, eol)}${eol}`);
      result.written = true;
    } else if (apply && result.status === "STALE" && updateStale) {
      const next = text.slice(0, result.begin.index) + pointerBlock(skill, body, eol) + text.slice(result.endIdx + POINTER_END(skill).length);
      fs.writeFileSync(pointerPath, next);
      result.written = true;
    }
    delete result.begin;
    delete result.endIdx;
    report.pointer = result;
  }
  report.collisions = [...report.adapters, report.pointer].filter((r) => r && ["COLLISION", "MODIFIED"].includes(r.status)).length;
  report.stale = [...report.adapters, report.pointer].filter((r) => r && r.status === "STALE" && !r.written).length;
  return report;
}

// Syncs each selected skill in turn. All names are validated before the first
// skill is touched, so a bad name never leaves a partial apply behind.
export function syncSkills({ skills, root = SHARED_ROOT, ...options }) {
  return selectSkills(skills, root).map((skill) => syncSkill({ ...options, skill, root }));
}

function parseArgs(argv) {
  const args = { apply: false, updateStale: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--update-stale") args.updateStale = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--check-source") args.checkSource = true;
    else if (arg === "--write-manifest") args.writeManifest = true;
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--hosts") args.hosts = argv[++i].split(",").filter(Boolean);
    else if (arg === "--skills") args.skills = argv[++i].split(",").filter(Boolean);
    else if (arg === "--source-ref") args.sourceRef = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.writeManifest) {
    const manifest = writeManifest(args);
    for (const skill of selectSkills(args.skills)) console.log(`manifest contentSha256 ${manifest.skills[skill].contentSha256} ${skill}`);
    return 0;
  }
  if (args.checkSource) {
    const results = checkSource(args);
    for (const r of results) console.log(r.ok ? `source OK ${r.actual} ${r.skill}` : `source DRIFT expected ${r.expected} actual ${r.actual} ${r.skill}`);
    return results.every((r) => r.ok) ? 0 : 1;
  }
  if (!args.target) throw new Error("--target <repo> is required");
  const reports = syncSkills(args);
  if (args.json) console.log(JSON.stringify(reports, null, 2));
  else {
    for (const report of reports) {
      console.log(`${report.applied ? "APPLY" : "DRY RUN"} ${report.skill} ${report.version} (${report.canonicalSha256.slice(0, 12)}) -> ${report.target}`);
      for (const a of report.adapters) console.log(`  ${a.status.padEnd(10)} ${a.path}${a.written ? " (written)" : ""}${a.detail ? ` - ${a.detail}` : ""}`);
      if (report.adapters.length === 0) console.log("  no host skill folders selected (pass --hosts)");
      console.log(`  ${report.pointer.status.padEnd(10)} ${report.pointer.file} pointer${report.pointer.written ? " (written)" : ""}${report.pointer.detail ? ` - ${report.pointer.detail}` : ""}`);
      for (const u of report.unmanaged) console.log(`  UNMANAGED  ${u} (not selected; left as is)`);
      console.log(`  collisions: ${report.collisions}, stale not updated: ${report.stale}`);
    }
  }
  return reports.some((r) => r.collisions > 0) ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`skill-sync: ${error.message}`);
    process.exitCode = 1;
  }
}
