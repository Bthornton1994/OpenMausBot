import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Advisory anti-slop run (`pnpm lint:anti-slop`). It never passes
// --deny-warnings, so findings print without failing the command; only a
// broken config or plugin exits non-zero.
//
// Oxlint resolves `ignorePatterns` inside the config file's own directory, so
// the advisory config cannot reuse the root list. Read it from the root
// .oxlintrc.json instead and pass each entry as --ignore-pattern.
const root = resolve(fileURLToPath(import.meta.url), "../../../..");
const { ignorePatterns } = JSON.parse(readFileSync(resolve(root, ".oxlintrc.json"), "utf8"));
const ignores = [...ignorePatterns, "tools/oxlint/anti-slop/**", "_cos/**"];

const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/oxlint/bin/oxlint"),
    "-c",
    "tools/oxlint/anti-slop/oxlintrc.advisory.json",
    ...ignores.map((pattern) => `--ignore-pattern=${pattern}`),
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
