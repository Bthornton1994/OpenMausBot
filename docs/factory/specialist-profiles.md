# Software-factory specialist profiles (t1774u)

Reusable specialist bot profiles for the CoS software factory. The catalog
lives in `server/factory-specialist-profiles.ts`. A matching OpenMaus team
package is produced by `buildSoftwareFactoryPackage()` and validates against
`shared/package-format.ts` using **only supported fields**.

## Team

| Profile id | Package key | Write class | Role |
| --- | --- | --- | --- |
| `chief-of-staff` | `chief-of-staff` | orchestrator | CoS orchestrator (not a product writer) |
| `advisor` | `advisor` | advisor | Fable 5.1 Advisor-only |
| `product-requirements` | `product-requirements` | spec-writer | PRD + acceptance criteria |
| `ux-accessibility` | `ux-accessibility` | spec-writer | UX + accessibility |
| `architecture` | `architecture` | spec-writer | Architecture |
| `implementation` | `implementation` | code-writer | Writes assigned changes |
| `test-engineering` | `test-engineering` | test-writer | May write tests |
| `independent-qa` | `independent-qa` | read-only | Independent QA |
| `security-privacy` | `security-privacy` | read-only | Security + privacy review |
| `production-readiness` | `production-readiness` | read-only | Production readiness |

These are **profile templates**, not live Pilot-* bot instances. Do not
duplicate existing Pilot bots; instantiate from the package when the owner
asks.

## What the package carries (OMB schema)

Per agent, only package-format fields:

- `key`, `name`, `title`, `description`, `soul`
- `appearance.color`
- `approval` — always `ask` here (schema note: imported bots still start on Ask)
- `playbooks`

**Not** in the package (and not invented): model id, tool allowlists,
`permittedActions`, `writeClass`, bridge tokens. Model/tool seating hints stay
on the profile object for CoS briefs only.

## What code enforces vs prompt-only (F-6)

| Concern | Enforcement | Mechanism |
| --- | --- | --- |
| Role narrative (`soul` / title / description / playbook) | **prompt-only** | Package text. Does **not** prove bot identity. |
| Factory action ceiling (edit/commit/push/etc.) | **code** | `assertMayPerform(profileId, action)` |
| Hard-forbidden (merge, deploy, undraft, push-upstream, clear gates, print-secrets, submit-qa-clearance, …) | **code** | Same helper; every profile lists the full hard-forbidden set |
| QA clearance / owner-gate clearance | **code (fail closed)** | `assertMaySubmitQaClearance` **always denies** on this tip — prompt role cannot clear |

**F-6:** Prompt-level roles alone do not prove bot identity or enforce QA
separation. A bot must not submit QA clearance unless identity and permissions
are enforced in code. This tip has no per-bot identity binding for clearance,
so clearance stays denied for every profile — including `independent-qa`.

Related residual on draft PR #1: the factory bridge token authorizes the
*caller*, not a bot (`docs/factory-lanes.md` QA hold). That bridge is **not**
on this branch; do not route specialists through PR #1 or claim dispatch works
while bridge 8798/8799 is DOWN.

## Forbidden for every profile

`grant-permissions`, `clear-project-gates`, `override-eligibility`,
`override-protect`, `merge`, `undraft`, `push-upstream`, `deploy`,
`enable-live-traffic`, `install-fabric`, `add-model-provider`,
`change-routing`, `print-secrets`, `submit-qa-clearance`.

Product gates stay owner-only: Markout C2/C3/C5, Media Lens #118/LIVE_URL,
Release Rescue #111.

## API

```ts
import {
  assertMayPerform,
  assertMaySubmitQaClearance,
  buildSoftwareFactoryPackage,
  getSpecialistProfile,
  listSpecialistProfiles,
  permissionMatrix,
} from "../server/factory-specialist-profiles.ts";

assertMayPerform("implementation", "edit-files"); // ok
assertMayPerform("independent-qa", "edit-files"); // throws action_denied
assertMaySubmitQaClearance("independent-qa"); // throws qa_clearance_denied (F-6)
const pkg = buildSoftwareFactoryPackage(); // PackageDocument v2
```

## Tests

```bash
pnpm exec vitest run server/factory-specialist-profiles.test.ts
```

## Operational status

Profiles are **catalog + package only**. Bots are **NOT OPERATIONAL** until an
authenticated bridge smoke and disposable claim/wait/report E2E pass. Bridge
8798/8799 is DOWN → report **NOT OPERATIONAL**. Do not issue shared bridge
credentials to bots.
