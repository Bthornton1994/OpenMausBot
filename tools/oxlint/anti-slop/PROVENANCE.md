# anti-slop Oxlint rules: provenance

This directory vendors a small subset of
[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) (MIT, see
[`LICENSE`](LICENSE)). It is a factory-host pilot (t1769u/t1771u). It is not
installed as a package, and nothing here is a shared factory standard.

## Upstream pin

- Repository: `https://github.com/dmmulroy/anti-slop`
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (package `oxlint-plugin-anti-slop` 0.1.2)
- Vendored: 2026-10-02
- Upstream built against `@oxlint/plugins` 1.78.0. OMB pins `@oxlint/plugins` 1.80.0
  to match its `oxlint` 1.80.0 (devDependency only).

## What is vendored

| Rule | Where it runs | Notes |
|---|---|---|
| `require-safety-comment-for-type-assertion` | advisory | unchanged |
| `no-chained-type-assertions` | advisory | unchanged |
| `no-widen-then-assert` | advisory | unchanged |
| `no-unsafe-dictionary-type` | advisory, `allow: ["unknown"]` | local `allow` option, see below |
| `no-reduce-accumulator-copy` | advisory only, by decision | unchanged; never gating in this pilot |

Shared helpers kept: `shared/array-method.ts`, `shared/dictionary-types.ts`,
`shared/type-alias-resolution.ts`, `shared/lexical-type-parameters.ts` (the
import closure of the five rules). The upstream `scope.ts`,
`reflect-method.ts` and `function-parameters.ts` helpers are not used by these
rules and are not vendored.

Not vendored (excluded on purpose): every `no-unknown-*` rule and any other
global `unknown` ban, `no-module-mocking`, `no-runtime-typeof`,
`no-array-filter-map`, `no-shape-in-symbol-names`, `require-readable-spacing`
(and its autofix), and the Effect rules.

OMB carried an older anti-slop plugin at this path (#190) with all of its
rules, these included, at `"error"` in `.oxlintrc.json`. #604 removed it. This
pilot re-adds only the subset above, outside the CI gate.

## Local adaptations

1. `index.ts` registers only the five rules above. Upstream's entry registers
   all of its rules.
2. `rules/no-unsafe-dictionary-type.ts` gains an `allow` option, a list from
   `"any" | "empty-object" | "object" | "unknown"`. Listed direct value kinds
   are not reported. Unions are never allowed. The default is `[]`, which keeps
   upstream behaviour, and upstream's tests still pass unchanged. OMB sets
   `allow: ["unknown"]` so `Record<string, unknown>`, the usual input to
   runtime validation, stays legal while `any`, `object` and `{}` values are
   still reported.
3. Everything else matches the pin, upstream tests included. The SHA-256 of
   each unchanged file matches the staged upstream copy. Files keep upstream
   formatting (some use tabs) so they diff cleanly against the next pin.

## How it runs

- `pnpm lint:anti-slop` runs `lint.mjs`, which calls oxlint with
  `oxlintrc.advisory.json` and **without** `--deny-warnings`. It prints
  findings and exits 0. Only a broken config or plugin fails it. The ignore
  list comes from the root `.oxlintrc.json`, because oxlint resolves a
  config's `ignorePatterns` inside that config's directory. `tools/oxlint/anti-slop/**`
  and `_cos/**` are skipped as well.
- `categories.correctness` is off in the advisory config, so the run reports
  only anti-slop rules. `pnpm lint` stays the gate.
- `pnpm lint` (`oxlint --deny-warnings .`) does **not** load this plugin. The
  only rule the pilot added to `.oxlintrc.json` is the native
  `oxc/no-accumulating-spread` (0 findings at the pilot base).
- `pnpm test:anti-slop` typechecks this directory (`tsconfig.json` extends
  `tsconfig.server.json`). It then runs the upstream rule tests and
  `anti-slop.test.ts` with `node --test`. Neither `pnpm test` nor CI runs this
  script.

## Analysis boundary

These rules look at one file at a time: the Oxlint AST, comments and
lexical scope, plus type aliases and interfaces declared **in the same
file**. They do not run the TypeScript checker and cannot see types across
files. In practice:

- An imported alias that resolves to `Record<string, unknown>` is not seen as a
  dictionary.
- `no-widen-then-assert` follows only local `const` flows inside one file.
- A clean run does not show that assertions are sound. It shows that the
  matched patterns are absent or carry a `SAFETY:` note.

Do not report these results as type-safety evidence.

## Updating to a new upstream pin

1. Fetch the new commit. Copy the five rule files, their `*.test.ts`, and the
   shared helpers they import into `rules/` and `shared/`.
2. Re-apply adaptation 2 to `no-unsafe-dictionary-type.ts`. Keep `index.ts`
   limited to the KEEP list.
3. Match `@oxlint/plugins` to the repo's `oxlint` version.
4. Run `pnpm test:anti-slop` and `pnpm lint:anti-slop`, then compare the
   finding counts with the last run before changing any rule's level.
5. Update the pin, the date and this file.
