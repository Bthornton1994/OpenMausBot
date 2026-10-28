import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const CONFIG = new URL("scripts/file-size-ratchet.json", ROOT);
const RECIPE = "Split by responsibility into at least N modules, each under 8,000 tokens. Move code verbatim (no rewrites while splitting). Leave the original path as a thin entry point that re-exports the moved symbols so imports keep working. Run the tests. Then commit; `node scripts/check-file-size.mjs --write-baseline` lowers the baseline for files that shrank.";
const git = (args, input) => execFileSync("git", args, { cwd: fileURLToPath(ROOT), encoding: null, input, maxBuffer: 256 * 1024 * 1024 });
const text = (args, input) => git(args, input).toString("utf8");
const config = () => JSON.parse(readFileSync(CONFIG, "utf8"));

function included(path, cfg) {
  return cfg.include.some((pattern) => matchesGlob(path, pattern)) &&
    !cfg.exclude.some((pattern) => matchesGlob(path, pattern));
}

function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (/^[RC]/.test(status)) changes.push({ status, oldPath: fields[i++], path: fields[i++] });
    else changes.push({ status, path: fields[i++] });
  }
  return changes;
}

function readBlob(spec) {
  return git(["cat-file", "blob", spec]);
}

function trackedPaths(revision) {
  return git(["ls-tree", "-rz", "--name-only", revision]).toString("utf8").split("\0").filter(Boolean);
}

function blobsForPaths(revision, paths) {
  const records = git(["ls-tree", "-rz", revision]).toString("utf8").split("\0").filter(Boolean);
  const objects = new Map(records.map((record) => {
    const [metadata, path] = record.split("\t");
    return [path, metadata.split(" ")[2]];
  }));
  const requested = paths.map((path) => objects.get(path)).filter(Boolean);
  const result = new Map();
  if (!requested.length) return result;
  const output = git(["cat-file", "--batch"], `${requested.join("\n")}\n`);
  let offset = 0;
  for (const oid of requested) {
    const end = output.indexOf(10, offset);
    const [returned, type, sizeText] = output.toString("ascii", offset, end).split(" ");
    if (returned !== oid || type !== "blob") throw new Error(`unexpected git object response for ${oid}`);
    const size = Number(sizeText);
    const start = end + 1;
    result.set(oid, output.subarray(start, start + size));
    offset = start + size + 1;
  }
  return new Map(paths.map((path) => [path, result.get(objects.get(path))]));
}

function tokensForBlob(bytes, cfg) {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return Math.floor(bytes.length / cfg.bytesPerToken);
}

function baselineFor(revision, cfg) {
  const baseline = {};
  const paths = trackedPaths(revision).filter((path) => included(path, cfg));
  const blobs = blobsForPaths(revision, paths);
  for (const path of paths) {
    const tokens = tokensForBlob(blobs.get(path), cfg);
    if (tokens !== null && tokens > cfg.maxTokens) baseline[path] = tokens;
  }
  return Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
}

function checkChanges(changes, cfg, specForPath) {
  const errors = [];
  for (const change of changes) {
    if (change.status.startsWith("D")) continue;
    const path = change.path;
    if (!included(path, cfg)) continue;
    const bytes = specForPath(path);
    const tokens = tokensForBlob(bytes, cfg);
    if (tokens === null) continue;
    const key = path;
    const limit = Object.hasOwn(cfg.baseline, key) ? cfg.baseline[key] : cfg.maxTokens;
    if (tokens > limit) {
      const minimum = Math.ceil(tokens / cfg.maxTokens);
      errors.push(`${path}: ${tokens} tokens (limit ${limit}${limit !== cfg.maxTokens ? `; baseline growth +${tokens - limit}` : ""}); minimum split count ${minimum}\n${RECIPE.replace("N", String(minimum))}\nCI runs this same check; skipping the hook does not skip the gate.`);
    } else if (Object.hasOwn(cfg.baseline, key) && tokens < cfg.baseline[key]) {
      console.log(`ratchet: lower baseline for ${path} to ${tokens} (run --write-baseline)`);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(`file size ratchet: ${error}`);
    return false;
  }
  return true;
}

function checkBaseline(base, cfg) {
  const mergeBase = text(["merge-base", base, "HEAD"]).trim();
  let baseConfig;
  let firstRollout = false;
  try {
    baseConfig = JSON.parse(readBlob(`${mergeBase}:scripts/file-size-ratchet.json`).toString("utf8"));
  } catch {
    // The rollout commit creates the config and its initial baseline.
    baseConfig = { baseline: {} };
    firstRollout = true;
  }
  const changes = parseNameStatus(git(["diff", "--name-status", "-z", "-M", `${mergeBase}...HEAD`, "--"]));
  const moves = new Map(changes.filter((c) => c.oldPath).map((c) => [c.oldPath, c.path]));
  const errors = [];
  if (!firstRollout) {
    for (const [path, value] of Object.entries(cfg.baseline)) {
      const oldPath = Object.hasOwn(baseConfig.baseline, path) ? path : [...moves].find(([, next]) => next === path)?.[0];
      if (!oldPath || !Object.hasOwn(baseConfig.baseline, oldPath)) errors.push(`baseline added: ${path} ${value}`);
      else if (value > baseConfig.baseline[oldPath]) errors.push(`baseline raised: ${path} ${baseConfig.baseline[oldPath]} -> ${value}`);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(error);
    return false;
  }
  return checkChanges(changes, cfg, (path) => readBlob(`HEAD:${path}`));
}

function writeBaseline(allowRaise) {
  const cfg = config();
  const head = text(["rev-parse", "HEAD"]).trim();
  const next = baselineFor(head, cfg);
  const problems = [];
  for (const [path, value] of Object.entries(next)) {
    if (!Object.hasOwn(cfg.baseline, path)) problems.push(`baseline added: ${path} ${value}`);
    else if (value > cfg.baseline[path]) problems.push(`baseline raised: ${path} ${cfg.baseline[path]} -> ${value}`);
  }
  if (problems.length && !allowRaise) {
    for (const problem of problems) console.error(`${problem} (pass --allow-raise to accept)`);
    return false;
  }
  if (problems.length) console.warn(`WARNING: accepting ${problems.length} baseline addition(s) or raise(s)`);
  cfg.baseline = next;
  writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`wrote ${Object.keys(next).length} baseline entries`);
  return true;
}

function main(args) {
  const cfg = config();
  if (args[0] === "--write-baseline") return writeBaseline(args.includes("--allow-raise")) ? 0 : 1;
  if (args[0] === "--staged") {
    const changes = parseNameStatus(git(["diff", "--cached", "--name-status", "-z", "-M", "--"]));
    return checkChanges(changes, cfg, (path) => readBlob(`:${path}`)) ? 0 : 1;
  }
  if (args[0] === "--base" && args[1]) return checkBaseline(args[1], cfg) ? 0 : 1;
  if (args[0] === "--all") {
    const paths = trackedPaths("HEAD");
    const blobs = blobsForPaths("HEAD", paths);
    const changes = paths.map((path) => ({ status: "M", path }));
    return checkChanges(changes, cfg, (path) => blobs.get(path)) ? 0 : 1;
  }
  console.error("usage: node scripts/check-file-size.mjs --staged | --base <sha> | --all | --write-baseline [--allow-raise]");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
