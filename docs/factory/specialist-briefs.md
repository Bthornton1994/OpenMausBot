# Factory specialist briefs

`server/factory-specialist-briefs.ts` holds five **read-only reviewer briefs**
for the software factory. Each brief is task text for one review. It does not
create a bot, change model routing, dispatch work, or touch the factory
bridge or lanes.

## Relation to the task-pattern catalog

The task-pattern catalog (`server/factory-task-patterns.ts`,
`docs/factory-task-patterns.md`) and the specialist profiles
(`server/factory-specialist-profiles.ts`) are on draft PRs and are not on
`main`. This module therefore imports neither:

- Each brief keeps the catalog's pattern v1 fields under the same names and
  meanings: `id`, `version`, `role`, `objective`, `inputs`, `steps`,
  `permittedTools`, `permittedActions`, `forbiddenActions`,
  `expectedArtifact`, `stopConditions`.
- It adds a `reviewer` role and the fields a reviewer needs: `title`,
  `whenToUse`, keyed `requiredEvidence`, `outcomes`, `reportSections`,
  `uncertaintyRules`, and `completionCondition`.
- The forbidden list starts from the catalog's `HARD_FORBIDDEN_ACTIONS` and
  the profiles' additions (`deploy`, `enable-live-traffic`,
  `submit-qa-clearance`), written out here.

The implementer, independent QA, and completion-report patterns are not part
of this module and are unchanged. Independent QA stays independent. No
reviewer may record a QA disposition or submit QA clearance, and the
release-readiness brief reads the QA record instead of replacing it.

## Catalog

| Id | Brief | Concluding outcomes | Permitted beyond read-repo, read-lane, record-findings, report-status |
| --- | --- | --- | --- |
| `codebase-navigator` | Codebase navigator | `MAPPED` | `run-tests`, `run-typecheck` |
| `security-privacy-review` | Security and privacy reviewer | `FINDINGS`, `NO_FINDINGS` | `run-tests`, `run-typecheck` |
| `ui-accessibility-review` | UI and accessibility reviewer | `FINDINGS`, `NO_FINDINGS` | `inspect-ui` |
| `game-interaction-review` | Game and interaction design reviewer (StageForge, Loadout) | `FINDINGS`, `NO_FINDINGS` | `inspect-ui` |
| `release-readiness-review` | Release-readiness reviewer | `RECONCILED`, `MISMATCH` | `read-ci-status`, `read-deploy-status` |

Every brief also offers `BLOCKED` and `NOT RUN`. The module checks at import
that the briefs are exactly these five and that each one validates.

### Required inputs and evidence

| Id | Required inputs | Required evidence keys |
| --- | --- | --- |
| `codebase-navigator` | `question`, `repo`, `sha` | `reviewedSha`, `entryPoints`, `flows`, `tests`, `docs` |
| `security-privacy-review` | `surface`, `repo`, `sha` | `reviewedSha`, `surfacesReviewed`, `checksRun` |
| `ui-accessibility-review` | `surface`, `interfaceSource` (running local or preview URL, or supplied screenshots) | `interfaceInspected`, `statesExercised`, `accessibilityChecks` |
| `game-interaction-review` | `product`, `build`, `visionRef`, `references`, `focus` | `buildInspected`, `visionRef`, `referencesRead`, `interactionsExercised` |
| `release-readiness-review` | `repo`, `sha`, `ciSource`, `qaRecord`, `deployTarget`, `launchGates` | `reviewedSha`, `ciRun`, `qaDisposition`, `deploymentState`, `launchGates` |

Each brief also states when to use it, its steps, its report sections in
order, its own uncertainty rules, its stop conditions, and a concrete
`Done when …` completion condition. Read them in the module.

## Read-only by construction

The reviewer action ceiling (`REVIEWER_ACTIONS`) is `read-repo`,
`read-lane`, `run-tests`, `run-typecheck`, `inspect-ui`, `read-ci-status`,
`read-deploy-status`, `record-findings`, and `report-status`. Every brief must
list all of `REVIEWER_FORBIDDEN_ACTIONS`:

- the catalog's hard-forbidden set: `grant-permissions`,
  `clear-project-gates`, `override-eligibility`, `override-protect`, `merge`,
  `undraft`, `push-upstream`, `install-fabric`, `add-model-provider`,
  `change-routing`, `print-secrets`
- the profiles' additions: `deploy`, `enable-live-traffic`,
  `submit-qa-clearance`
- reviewer-specific: `edit-files`, `commit`, `push-fork`, `approve-pr`,
  `set-product-flags`, `clear-owner-gates`, `claim-production-readiness`,
  `record-qa-disposition`, `give-legal-advice`, `attest-for-owner`

A brief's outcomes may not read as a pass, approval, or clearance. An outcome
matching `PASS`, `APPROV`, `CLEAR`, `READY`, `MERGE`, `LAUNCH`, `SHIP`,
`DEPLOY`, or `GO LIVE` fails validation, so `PASS_KEEP_DRAFT` can never be a
reviewer outcome. The release-readiness brief reports a recorded
`PASS_KEEP_DRAFT` verbatim as evidence. `RECONCILED` only means all four
sources were read for the same SHA.

## Uncertainty, missing inputs, and NOT RUN

Every rendered brief carries `SHARED_UNCERTAINTY_RULES`:

- Label every claim `verified`, `inferred`, or `unknown`. A verified claim
  cites its evidence.
- Label every check `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or `UNKNOWN`. A
  check that did not run is `NOT RUN`, never `PASS`.
- A missing or unusable required input means outcome `BLOCKED`, with what is
  missing named.
- Skipped or unfinished checks are listed under Not run.

Brief-specific rules add to these. For example, the UI brief reports
`BLOCKED` when it cannot view the interface, and the game brief treats a
finding without a cited vision line or approved reference as an open
question.

## API

| Function | Fails closed when |
| --- | --- |
| `getSpecialistBrief(id)` | id is not one of the five (`unknown_brief`) |
| `listSpecialistBriefIds()` | never; returns the five ids |
| `validateSpecialistBrief(brief)` | not a catalog id, wrong version or role, empty field, action outside the ceiling or on the deny list, missing forbidden action, pass- or clearance-like outcome, no `BLOCKED` / `NOT RUN` / concluding outcome, undeclared placeholder |
| `assertReviewerActionsAllowed(id, actions)` | any action forbidden, unknown, or not permitted by that brief (`action_denied`) |
| `renderSpecialistBrief(id, vars)` | unknown id (`unknown_brief`); a required input missing or blank, an unknown or non-string var, `{{`/`}}` in a var, or a `sha` that is not 40-hex (`invalid_vars`) |
| `checkSpecialistReport(report)` | unknown field or evidence key, an outcome the brief does not offer (`invalid_report`); a concluding outcome missing any required evidence, evidence that is only a status word (`PASS`, `NOT RUN`, `TBD`, …), a `reviewedSha` without a full SHA, or a `verified` claim without evidence (`evidence_missing`); `BLOCKED` or `NOT RUN` without `missing` (`invalid_report`) |

All failures throw `SpecialistBriefError` with a `code`. Returned briefs and
reports are deeply frozen.

A rendered brief ends with the fixed `REVIEWER_GUARDRAILS`. A brief carries no
authority, and a report is advisory: it is not Independent QA, not a PR
approval, and not merge, deploy, launch, or production-readiness clearance.

## Not covered

- Rendered prose is not run through the catalog's override-wording scan,
  which lives only on the draft catalog branch. Briefs are built-in only;
  there is no overlay.
- Nothing dispatches these briefs, and no bridge dispatch test has been run.
- The fixtures in the tests are synthetic. No brief has been run against a
  real product.

## Tests

```sh
pnpm exec vitest run server/factory-specialist-briefs.test.ts
```
