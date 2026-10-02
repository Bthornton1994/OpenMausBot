# Factory task patterns

`server/factory-task-patterns.ts` is the **single source of truth** for
reusable factory task briefs. Do not keep a second copy elsewhere (for
example under portfolio coordination); change this module.

## Catalog (t1752u)

The catalog is **exactly three** patterns (`CATALOG_PATTERN_IDS`):

| Id | Brief | Role |
| --- | --- | --- |
| `implementer-brief` | Implementer task brief | `implementer` |
| `independent-qa-brief` | Independent QA brief | `qa` |
| `completion-report` | Completion report | `reporter` |

The earlier `eligibility-check` and `digest-harvest` patterns were removed in
t1752u; their ids are unknown and fail closed. Eligibility and digest
harvesting stay in their own code (e.g. `server/factory-protect-gate.ts`), not in
pattern text. The module checks at import that the built-ins are exactly the
catalog.

It is a pure, declarative server module: no HTTP route, MCP tool, model
provider, or routing change, and it is not wired into the factory bridge or
lanes. Callers import it and get validated pattern objects or rendered brief
text.

The idea comes from [Fabric](https://github.com/danielmiessler/fabric)'s
*patterns*: a reusable prompt with a clear identity, steps, and output.
Only the idea is borrowed. Fabric is not a dependency, is not installed, and
none of its code is used.

## Where patterns live

1. **Built-ins** — `BUILT_IN_PATTERNS` in the module: the whole catalog.
   Validated at import, so a bad built-in fails at startup.
2. **Overlay (optional, narrow-only)** — when `COS_FACTORY_ROOT` is set (or a
   caller passes `root`), every `$COS_FACTORY_ROOT/patterns/<id>.json` is read
   fresh on each lookup and run through the same validator.
   - The file name must be `<id>.json`.
   - The id must be one of the three catalog ids. An overlay cannot add a
     pattern; any other id fails the lookup with `unknown_pattern`.
   - An overlay may only **narrow** its built-in: same role, permitted
     actions a subset of the built-in's, forbidden actions a superset.
   - An overlay that sets `stopConditions` or `verificationEvidence` must
     supply a superset of the built-in list (every built-in entry remains;
     entries may only be added), and omitting either field inherits the
     built-in list, while dropping or replacing an entry fails closed with
     `overlay_not_narrow`.
   - No `patterns` directory means no overlay. Any other failure (unreadable
     directory, bad JSON, invalid pattern, id outside the catalog) fails the
     whole lookup. A broken overlay is never treated as "use the built-ins".

## Format (version 1)

Every pattern declares the same things:

| Declaration | Field(s) | Required | Notes |
| --- | --- | --- | --- |
| Identity | `id`, `version` | yes | kebab-case id; `version` must be `1` (the format version) |
| Purpose | `objective` | yes | one line; may use `{{input}}` placeholders |
| Required inputs | `inputs` | yes | `[{ name, description, required }]` |
| Procedure | `steps` | yes | non-empty ordered list |
| Expected output | `expectedArtifact` | yes | `{ kind, description }` |
| Evidence requirements | `verificationEvidence` | yes | non-empty list |
| Role/tool scope | `role` | yes | `implementer`, `qa`, or `reporter` |
| | `permittedTools` | yes | non-empty list of tool descriptions |
| | `permittedActions` | yes | non-empty; ids from `PERMITTABLE_ACTIONS`, within the role's ceiling |
| | `forbiddenActions` | yes | must include every id in `HARD_FORBIDDEN_ACTIONS` |
| Stop conditions | `stopConditions` | yes | non-empty list |

Unknown fields are rejected. Text fields are capped at 2,000 characters and
lists at 32 entries. Placeholders must name a declared input.

Hard-forbidden actions: `grant-permissions`, `clear-project-gates`,
`override-eligibility`, `override-protect`, `merge`, `undraft`,
`push-upstream`, `install-fabric`, `add-model-provider`, `change-routing`,
`print-secrets`.

Role ceilings: `implementer` may read, edit, run tests/typecheck, commit,
push to the fork, append evidence, and write a digest. `qa` may read, run
tests/typecheck, record a disposition, append evidence, and write a digest —
never edit, commit, or push. `reporter` only reads and records.

## API

| Function | Fails closed when |
| --- | --- |
| `getPattern(id, { root?, env? })` | id unknown, not in the catalog, or not kebab-case; overlay bad |
| `listPatternIds(options)` / `loadPatterns(options)` | overlay bad or adds an id outside the catalog |
| `validatePattern(raw)` | field missing/malformed/unknown, wrong version or role, forbidden/unknown/over-ceiling action, missing hard-forbidden entry, undeclared placeholder, override wording |
| `assertActionsAllowed(pattern, actions)` | pattern invalid (re-validated), or any action not permitted or on a deny list |
| `renderBrief(pattern, vars)` | pattern invalid; unknown, missing-required, non-string, or `{{…}}`-containing vars; override wording in any var or in the assembled prose |

All failures throw `FactoryPatternError` with a `code`: `unknown_pattern`,
`invalid_pattern`, `action_denied`, `override_attempt`, `invalid_vars`,
`overlay_unavailable`, or `overlay_not_narrow`. Returned patterns are deeply frozen.

## Briefs carry no authority

A rendered brief is text for a worker. It never grants permissions, clears
owner or project gates, or overrides factory eligibility or protect
decisions; those come only from their own systems
(`server/factory-protect-gate.ts`, the owner).

This is enforced, not just stated:

- **Structural.** Permitted and forbidden actions are ids from fixed lists,
  checked against the role ceiling. A pattern cannot permit a hard-forbidden
  action or drop one from its deny list.
- **Scan.** Every prose field, every variable, and the assembled brief are
  scanned for wording that grants permissions, clears gates, overrides
  eligibility/protect/frozen checks, or tells the reader to ignore prior
  instructions. Text is folded first (NFKC, zero-width characters removed,
  `-`/`_` read as spaces, case-insensitive). Negated wording ("do not clear
  the gate") is rejected too: pattern prose does not talk about authority at
  all.
- **Fixed guardrails.** After the scan, the renderer appends the action lists
  and a fixed guardrail section (`BRIEF_GUARDRAILS`) that patterns cannot edit
  or remove.

The scan is a backstop, not the boundary. The boundary is that nothing reads
a brief to decide permissions, gates, or eligibility.

## Tests

`server/factory-task-patterns.test.ts`:

```sh
pnpm exec vitest run server/factory-task-patterns.test.ts
```
