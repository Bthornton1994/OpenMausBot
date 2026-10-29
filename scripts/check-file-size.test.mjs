import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = readFileSync(new URL("./check-file-size.mjs", import.meta.url));
const root = mkdtempSync(join(os.tmpdir(), "file-size-ratchet-"));
let serial = 0;

function repo(config = {}) {
  const cwd = join(root, String(++serial));
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  writeFileSync(join(cwd, "scripts/check-file-size.mjs"), source);
  const cfg = { version: 1, maxTokens: 8, bytesPerToken: 1, include: ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,sql,css,scss,sh,ps1,go,rs,vue,svelte,html,kt,swift,java,rb,php,yml,yaml,toml}"], exclude: ["**/pnpm-lock.yaml", "build/**", "third_party/**", "electron/vendor/**", "**/fixtures/**", "evals/golden/**", "**/__snapshots__/**", "**/*.snap", "**/*.min.*", "**/*.map", "shared/mascot-bodies.ts", "ios/**/MausFaceData.swift"], baseline: {}, ...config };
  writeConfig(cwd, cfg);
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "fixture");
  git(cwd, "config", "user.email", "fixture@example.test");
  git(cwd, "config", "core.autocrlf", "false");
  commit(cwd, "base");
  return { cwd, cfg };
}

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function writeConfig(cwd, cfg) { writeFileSync(join(cwd, "scripts/file-size-ratchet.json"), `${JSON.stringify(cfg, null, 2)}\n`); }
function commit(cwd, message) { git(cwd, "add", "-A"); git(cwd, "commit", "-qm", message); }
function run(cwd, ...args) { return spawnSync(process.execPath, [join(cwd, "scripts/check-file-size.mjs"), ...args], { cwd, encoding: "utf8" }); }
function cleanup() { rmSync(root, { recursive: true, force: true }); }

test.after(cleanup);

test("new small file passes and new oversized file gives split count and recipe", () => {
  const { cwd } = repo();
  writeFileSync(join(cwd, "small.ts"), "12345678");
  git(cwd, "add", "small.ts");
  assert.equal(run(cwd, "--staged").status, 0);
  writeFileSync(join(cwd, "large.ts"), "12345678901234567890");
  git(cwd, "add", "large.ts");
  const result = run(cwd, "--staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /minimum split count 3/);
  assert.match(result.stderr, /Move code verbatim/);
  assert.match(result.stderr, /skipping the hook does not skip the gate/);
});

test("baselined files may shrink or stay the same but may not grow", () => {
  const { cwd, cfg } = repo({ baseline: { "large.ts": 12 } });
  writeFileSync(join(cwd, "large.ts"), "123456789012");
  writeConfig(cwd, cfg); commit(cwd, "baseline");
  writeFileSync(join(cwd, "large.ts"), "12345678901"); git(cwd, "add", "large.ts");
  assert.equal(run(cwd, "--staged").status, 0);
  writeFileSync(join(cwd, "large.ts"), "123456789012"); git(cwd, "add", "large.ts");
  assert.equal(run(cwd, "--staged").status, 0);
  writeFileSync(join(cwd, "large.ts"), "1234567890123"); git(cwd, "add", "large.ts");
  assert.match(run(cwd, "--staged").stderr, /baseline growth \+1/);
});

test("unbaselined crossing, excluded paths, and binary blobs", () => {
  const { cwd } = repo();
  writeFileSync(join(cwd, "cross.ts"), "123456789");
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "x".repeat(100));
  mkdirSync(join(cwd, "build")); writeFileSync(join(cwd, "build/out.ts"), "x".repeat(100));
  mkdirSync(join(cwd, "third_party")); writeFileSync(join(cwd, "third_party/vendor.ts"), "x".repeat(100));
  writeFileSync(join(cwd, "large.snap"), "x".repeat(100));
  mkdirSync(join(cwd, "shared"), { recursive: true });
  writeFileSync(join(cwd, "shared/mascot-bodies.ts"), "x".repeat(100));
  mkdirSync(join(cwd, "ios/App"), { recursive: true });
  writeFileSync(join(cwd, "ios/App/MausFaceData.swift"), "x".repeat(100));
  writeFileSync(join(cwd, "binary.ts"), Buffer.concat([Buffer.from([0]), Buffer.from("x".repeat(100))]));
  git(cwd, "add", "-A");
  const result = run(cwd, "--staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cross.ts/);
  for (const excluded of ["pnpm-lock.yaml", "build/out.ts", "third_party/vendor.ts", "large.snap", "shared/mascot-bodies.ts", "ios/App/MausFaceData.swift", "binary.ts"]) assert.doesNotMatch(result.stderr, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("staged LF blob size is independent of CRLF worktree conversion", () => {
  const { cwd } = repo();
  writeFileSync(join(cwd, "lf.ts"), "12345678\n"); commit(cwd, "lf source");
  git(cwd, "config", "core.autocrlf", "true");
  writeFileSync(join(cwd, "lf.ts"), "12345678\r\n"); git(cwd, "add", "lf.ts");
  assert.equal(run(cwd, "--staged").status, 0);
});

test("rename passes only when the baseline key moves", () => {
  const { cwd, cfg } = repo({ baseline: { "old.ts": 12 } });
  writeFileSync(join(cwd, "old.ts"), "123456789012"); writeConfig(cwd, cfg); commit(cwd, "old baseline");
  git(cwd, "mv", "old.ts", "new.ts");
  cfg.baseline = { "new.ts": 12 }; writeConfig(cwd, cfg); git(cwd, "add", "scripts/file-size-ratchet.json");
  assert.equal(run(cwd, "--staged").status, 0);
  cfg.baseline = { "old.ts": 12 }; writeConfig(cwd, cfg); git(cwd, "add", "scripts/file-size-ratchet.json");
  assert.match(run(cwd, "--staged").stderr, /new.ts: 12 tokens \(limit 8/);
});

test("CI detects baseline additions and raises, and initial rollout accepts its first baseline", () => {
  const { cwd, cfg } = repo({ baseline: { "source.ts": 9 } });
  writeFileSync(join(cwd, "source.ts"), "123456789");
  commit(cwd, "baseline source");
  cfg.baseline["source.ts"] = 10; writeConfig(cwd, cfg); commit(cwd, "raise");
  assert.match(run(cwd, "--base", git(cwd, "rev-parse", "HEAD~1")).stderr, /baseline raised: source.ts 9 -> 10/);
  cfg.baseline = { "source.ts": 9, "added.ts": 9 }; writeConfig(cwd, cfg); commit(cwd, "add entry");
  assert.match(run(cwd, "--base", git(cwd, "rev-parse", "HEAD~1")).stderr, /baseline added: added.ts 9/);
});

test("baseline regeneration refuses additions without explicit allow-raise and removes deleted paths", () => {
  const { cwd } = repo();
  writeFileSync(join(cwd, "large.ts"), "x".repeat(9)); commit(cwd, "large file");
  assert.equal(run(cwd, "--write-baseline").status, 1);
  assert.equal(run(cwd, "--write-baseline", "--allow-raise").status, 0);
  const regenerated = JSON.parse(readFileSync(join(cwd, "scripts/file-size-ratchet.json"), "utf8"));
  assert.equal(regenerated.baseline["large.ts"], 9);
  git(cwd, "rm", "large.ts"); commit(cwd, "delete large source");
  assert.equal(run(cwd, "--write-baseline").status, 0);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(cwd, "scripts/file-size-ratchet.json"), "utf8")).baseline, "large.ts"), false);
});
