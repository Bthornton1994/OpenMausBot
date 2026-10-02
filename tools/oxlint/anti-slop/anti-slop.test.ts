// OMB-specific checks for the vendored anti-slop subset. The upstream rule
// tests live next to each rule in rules/*.test.ts.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

import antiSlopPlugin from "./index.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const here = resolve(fileURLToPath(import.meta.url), "..");
const root = resolve(here, "../../..");
const advisoryConfig = JSON.parse(readFileSync(resolve(here, "oxlintrc.advisory.json"), "utf8"));
const keep = [
  "no-chained-type-assertions",
  "no-reduce-accumulator-copy",
  "no-unsafe-dictionary-type",
  "no-widen-then-assert",
  "require-safety-comment-for-type-assertion",
];
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

describe("anti-slop plugin surface", () => {
  it("exposes only the KEEP rules", () => {
    assert.deepEqual(Object.keys(antiSlopPlugin.rules).sort(), keep);
  });

  it("enables every KEEP rule in the advisory config at warn", () => {
    assert.deepEqual(Object.keys(advisoryConfig.rules).sort(), keep.map((rule) => `anti-slop/${rule}`));
    for (const setting of Object.values(advisoryConfig.rules)) {
      assert.equal(Array.isArray(setting) ? setting[0] : setting, "warn");
    }
  });

  it("keeps the main lint free of anti-slop rules", () => {
    const main = JSON.parse(readFileSync(resolve(root, ".oxlintrc.json"), "utf8"));
    assert.equal(main.jsPlugins, undefined);
    assert.ok(Object.keys(main.rules ?? {}).every((rule) => !rule.startsWith("anti-slop/")));
  });
});

const parseThenValidate = [
  "type User = { id: string };",
  "function isRecord(value: unknown): value is Record<string, unknown> {",
  "  return typeof value === 'object' && value !== null;",
  "}",
  "export function parse(raw: string): User | null {",
  "  const value: unknown = JSON.parse(raw);",
  "  if (!isRecord(value) || typeof value.id !== 'string') return null;",
  "  return { id: value.id };",
  "}",
].join("\n");

// Options the advisory config passes to each rule, so these cases match `pnpm lint:anti-slop`.
const advisoryCase = (rule: string, code: string) => {
  const setting = advisoryConfig.rules[`anti-slop/${rule}`];
  return Array.isArray(setting) ? { code, options: setting.slice(1) } : { code };
};

for (const rule of keep) {
  tester.run(`anti-slop/${rule} (unknown before validation stays legal)`, antiSlopPlugin.rules[rule], {
    valid: [advisoryCase(rule, parseThenValidate)],
    invalid: [],
  });
}

const dictionaryError = { messageId: "unsafeDictionary" };
tester.run("anti-slop/no-unsafe-dictionary-type (OMB allow option)", antiSlopPlugin.rules["no-unsafe-dictionary-type"], {
  valid: [
    { code: "type Fields = Record<string, unknown>;", options: [{ allow: ["unknown"] }] },
    { code: "const fields = value as Record<string, unknown>;", options: [{ allow: ["unknown"] }] },
    { code: "interface Fields { [key: string]: unknown }", options: [{ allow: ["unknown"] }] },
    { code: "type Loose = Record<string, any>;", options: [{ allow: ["any", "unknown"] }] },
  ],
  invalid: [
    { code: "type Fields = Record<string, unknown>;", errors: [dictionaryError] },
    { code: "type Fields = Record<string, unknown>;", options: [{ allow: [] }], errors: [dictionaryError] },
    { code: "type Loose = Record<string, any>;", options: [{ allow: ["unknown"] }], errors: [dictionaryError] },
    { code: "type Bag = Record<string, object>;", options: [{ allow: ["unknown"] }], errors: [dictionaryError] },
    { code: "type Mixed = Record<string, string | unknown>;", options: [{ allow: ["unknown"] }], errors: [dictionaryError] },
    { code: "interface Loose { [key: string]: any }", options: [{ allow: ["unknown"] }], errors: [dictionaryError] },
  ],
});

describe("advisory config end to end", () => {
  const run = (file: string) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "node_modules/oxlint/bin/oxlint"), "-c", resolve(here, "oxlintrc.advisory.json"), "--format=unix", file],
      { cwd: root, encoding: "utf8" },
    );
    const findings = [...result.stdout.matchAll(/anti-slop\(([a-z-]+)\)/g)].map((match) => match[1]).sort();
    return { status: result.status, findings, output: result.stdout + result.stderr };
  };

  it("reports one finding per KEEP rule in the slop fixture without failing", () => {
    const { status, findings, output } = run("tools/oxlint/anti-slop/fixtures/slop.ts");
    assert.equal(status, 0, output);
    assert.deepEqual(findings, keep, output);
  });

  it("reports nothing for parse-then-validate code", () => {
    const { status, findings, output } = run("tools/oxlint/anti-slop/fixtures/unknown-before-validation.ts");
    assert.equal(status, 0, output);
    assert.deepEqual(findings, [], output);
  });
});
