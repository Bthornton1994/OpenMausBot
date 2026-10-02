/**
 * Software-factory specialist profiles (t1774u).
 *
 * Pure declarative catalog + fail-closed action checks for the CoS software
 * factory team. Not wired into the factory bridge or lanes (those live on
 * draft PR #1; bridge 8798/8799 is DOWN). Produces an OpenMaus package that
 * validates against `shared/package-format.ts` using only supported fields
 * (key, name, title, description, soul, appearance, approval, playbooks).
 *
 * ## F-6 — prompt roles ≠ identity / QA separation
 *
 * Package `soul` / `description` / `title` and playbook instructions are
 * **prompt-level only**. They do not prove which bot is speaking, and they
 * do not enforce read-only QA separation by themselves. What this module
 * enforces in code is only what `assertMayPerform` and
 * `assertMaySubmitQaClearance` refuse. `submit-qa-clearance` is hard-forbidden
 * for every profile and `assertMaySubmitQaClearance` always fails closed
 * unless a caller proves both authenticated bot identity and a permission
 * binding that exist in code (they do not on this tip). Do not treat a
 * prompt that says "I am Independent QA" as clearance.
 *
 * CoS remains the orchestrator. Fable / advisor is advisor-only (no writes,
 * no clearance, no deploy). No profile may merge, deploy, enable live
 * traffic, undraft, push upstream, or clear owner-only gates.
 */

import {
  parsePackageDocument,
  type PackageDocument,
} from "../shared/package-format.ts";

export const SPECIALIST_PROFILES_FORMAT_VERSION = 1 as const;

export const SPECIALIST_PROFILE_IDS = [
  "product-requirements",
  "ux-accessibility",
  "architecture",
  "implementation",
  "test-engineering",
  "independent-qa",
  "security-privacy",
  "production-readiness",
] as const;

export type SpecialistProfileId = (typeof SPECIALIST_PROFILE_IDS)[number];

/** CoS orchestrator — not a specialist; owns delegation only. */
export const ORCHESTRATOR_PROFILE_ID = "chief-of-staff" as const;
/** Fable / advisor — advisor-only; never a writer or clearance authority. */
export const ADVISOR_PROFILE_ID = "advisor" as const;

export type FactoryTeamProfileId =
  | SpecialistProfileId
  | typeof ORCHESTRATOR_PROFILE_ID
  | typeof ADVISOR_PROFILE_ID;

export type WriteClass =
  | "orchestrator"
  | "advisor"
  | "spec-writer"
  | "code-writer"
  | "test-writer"
  | "read-only";

/**
 * Actions that are always denied for every factory profile. Aligns with the
 * factory-task-patterns HARD_FORBIDDEN set (draft PR #1) plus deploy / live
 * traffic / QA-clearance. Listed here rather than imported so this tip does
 * not depend on unmerged PR #1 modules.
 */
export const HARD_FORBIDDEN_ACTIONS = [
  "grant-permissions",
  "clear-project-gates",
  "override-eligibility",
  "override-protect",
  "merge",
  "undraft",
  "push-upstream",
  "deploy",
  "enable-live-traffic",
  "install-fabric",
  "add-model-provider",
  "change-routing",
  "print-secrets",
  "submit-qa-clearance",
] as const;

export type HardForbiddenAction = (typeof HARD_FORBIDDEN_ACTIONS)[number];

/** Closed set of actions a profile may ever list as permitted. */
export const PERMITTABLE_ACTIONS = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "write-spec",
  "edit-files",
  "edit-tests",
  "commit",
  "push-fork",
  "append-evidence",
  "write-digest",
  "report-status",
  "record-findings",
  "advise",
  "delegate",
  "orchestrate",
] as const;

export type PermittableAction = (typeof PERMITTABLE_ACTIONS)[number];
export type FactoryAction = HardForbiddenAction | PermittableAction;

export type EnforcementKind = "code" | "prompt-only";

export type SpecialistProfile = {
  id: FactoryTeamProfileId;
  /** Package agent key — must match package agents[].key. */
  packageKey: string;
  displayName: string;
  title: string;
  writeClass: WriteClass;
  /** Suggested package approval. Schema note: imported bots still start on Ask. */
  approval: "ask" | "auto";
  scope: string;
  inputs: readonly string[];
  outputs: readonly string[];
  permittedActions: readonly PermittableAction[];
  /** Must include every HARD_FORBIDDEN_ACTIONS id. */
  forbiddenActions: readonly HardForbiddenAction[];
  /** Model hint for CoS seating — not a package field (packages omit models). */
  modelHint: string;
  /** Tool / seating hint — not a package field. */
  toolHint: string;
  /** What is actually enforced in code vs prompt-only (F-6). */
  enforcement: {
    roleText: EnforcementKind;
    actionCeiling: EnforcementKind;
    qaClearance: EnforcementKind;
  };
  soul: string;
  description: string;
  playbookKey: string;
  playbook: {
    name: string;
    summary: string;
    triggers: readonly string[];
    instructions: string;
  };
  appearance: { color: "green" | "blue" | "red" | "orange" | "purple" | "cyan" | "pink" | "yellow" | "teal" | "coral" };
};

export class SpecialistProfileError extends Error {
  readonly code: "unknown_profile" | "action_denied" | "invalid_profile" | "qa_clearance_denied";
  constructor(code: SpecialistProfileError["code"], message: string) {
    super(message);
    this.name = "SpecialistProfileError";
    this.code = code;
  }
}

function fail(code: SpecialistProfileError["code"], message: string): never {
  throw new SpecialistProfileError(code, message);
}

const ALL_FORBIDDEN: readonly HardForbiddenAction[] = [...HARD_FORBIDDEN_ACTIONS];

function requireAllForbidden(id: string, forbidden: readonly HardForbiddenAction[]): void {
  const missing = HARD_FORBIDDEN_ACTIONS.filter((action) => !forbidden.includes(action));
  if (missing.length) fail("invalid_profile", `${id} forbiddenActions must include ${missing.join(", ")}`);
}

function freezeProfile(profile: SpecialistProfile): SpecialistProfile {
  requireAllForbidden(profile.id, profile.forbiddenActions);
  for (const action of profile.permittedActions) {
    if ((HARD_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
      fail("invalid_profile", `${profile.id} permits hard-forbidden action ${action}`);
    }
    if (!(PERMITTABLE_ACTIONS as readonly string[]).includes(action)) {
      fail("invalid_profile", `${profile.id} permits unknown action ${action}`);
    }
    if (profile.forbiddenActions.includes(action as HardForbiddenAction)) {
      fail("invalid_profile", `${profile.id} lists ${action} as both permitted and forbidden`);
    }
  }
  if (profile.writeClass === "read-only" || profile.writeClass === "advisor") {
    const writers = profile.permittedActions.filter((a) =>
      a === "edit-files" || a === "edit-tests" || a === "write-spec" || a === "commit" || a === "push-fork"
    );
    if (writers.length) {
      fail("invalid_profile", `${profile.id} writeClass ${profile.writeClass} may not permit ${writers.join(", ")}`);
    }
  }
  if (profile.writeClass === "code-writer" && !profile.permittedActions.includes("edit-files")) {
    fail("invalid_profile", `${profile.id} code-writer must permit edit-files`);
  }
  if (profile.writeClass === "test-writer" && !profile.permittedActions.includes("edit-tests")) {
    fail("invalid_profile", `${profile.id} test-writer must permit edit-tests`);
  }
  if (profile.enforcement.roleText !== "prompt-only") {
    fail("invalid_profile", `${profile.id} roleText enforcement must be prompt-only (F-6)`);
  }
  if (profile.enforcement.actionCeiling !== "code") {
    fail("invalid_profile", `${profile.id} actionCeiling enforcement must be code`);
  }
  if (profile.enforcement.qaClearance !== "code") {
    fail("invalid_profile", `${profile.id} qaClearance enforcement must be code`);
  }
  return Object.freeze({
    ...profile,
    inputs: Object.freeze([...profile.inputs]),
    outputs: Object.freeze([...profile.outputs]),
    permittedActions: Object.freeze([...profile.permittedActions]),
    forbiddenActions: Object.freeze([...profile.forbiddenActions]),
    enforcement: Object.freeze({ ...profile.enforcement }),
    playbook: Object.freeze({
      ...profile.playbook,
      triggers: Object.freeze([...profile.playbook.triggers]),
    }),
    appearance: Object.freeze({ ...profile.appearance }),
  });
}

const F6_SOUL_TAIL =
  "\n\nF-6: Your role text does not prove identity. You cannot clear owner gates, merge, deploy, undraft, push upstream, or enable live traffic. Do not claim QA clearance.";

const READ_ONLY_ACTIONS: readonly PermittableAction[] = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "append-evidence",
  "write-digest",
  "report-status",
  "record-findings",
];

const SPEC_WRITER_ACTIONS: readonly PermittableAction[] = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "write-spec",
  "commit",
  "push-fork",
  "append-evidence",
  "write-digest",
  "report-status",
];

const CODE_WRITER_ACTIONS: readonly PermittableAction[] = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "edit-files",
  "commit",
  "push-fork",
  "append-evidence",
  "write-digest",
  "report-status",
];

const TEST_WRITER_ACTIONS: readonly PermittableAction[] = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "edit-tests",
  "commit",
  "push-fork",
  "append-evidence",
  "write-digest",
  "report-status",
];

function mk(
  partial: Omit<SpecialistProfile, "forbiddenActions" | "enforcement"> & {
    forbiddenActions?: readonly HardForbiddenAction[];
  },
): SpecialistProfile {
  return freezeProfile({
    ...partial,
    forbiddenActions: partial.forbiddenActions ?? ALL_FORBIDDEN,
    enforcement: {
      roleText: "prompt-only",
      actionCeiling: "code",
      qaClearance: "code",
    },
  });
}

const RAW: SpecialistProfile[] = [
  mk({
    id: ORCHESTRATOR_PROFILE_ID,
    packageKey: "chief-of-staff",
    displayName: "Factory CoS",
    title: "Chief of Staff — orchestrator",
    writeClass: "orchestrator",
    approval: "ask",
    scope: "Orchestrate specialist seats; never implement product changes or clear owner gates.",
    inputs: ["task brief", "protected tips", "eligibility SoT"],
    outputs: ["seat briefs", "status reports", "draft-PR coordination notes"],
    permittedActions: ["read-repo", "read-lane", "append-evidence", "write-digest", "report-status", "delegate", "orchestrate"],
    modelHint: "Opus 5.5 UltraCode (Extra OK) for seating writers; CoS may use Grok Bot.",
    toolHint: "Orchestrator only; Claude Code --permission-mode auto when seating writers on Windows.",
    soul: `You are the Chief of Staff for the software factory. Delegate to specialists; do not write product code yourself. Fable is advisor-only. Keep draft PRs draft. Bridge DOWN means NOT OPERATIONAL — do not claim dispatch works.${F6_SOUL_TAIL}`,
    description: "CoS orchestrator for the software factory specialist team.",
    playbookKey: "orchestrate-lane",
    playbook: {
      name: "Orchestrate a factory lane",
      summary: "Seat the right specialist, collect digests, keep gates owner-only.",
      triggers: ["orchestrate", "seat", "dispatch"],
      instructions:
        "Confirm tip and worktree. Seat one specialist with a t1725u assumptions checklist. Never merge, undraft, deploy, or clear product gates. If bridge is DOWN, report NOT OPERATIONAL.",
    },
    appearance: { color: "purple" },
  }),
  mk({
    id: ADVISOR_PROFILE_ID,
    packageKey: "advisor",
    displayName: "Fable Advisor",
    title: "Advisor only",
    writeClass: "advisor",
    approval: "ask",
    scope: "Advise on approach and risks; never edit, commit, push, or clear gates.",
    inputs: ["question", "context digest"],
    outputs: ["advice", "risk notes"],
    permittedActions: ["read-repo", "read-lane", "advise", "report-status"],
    modelHint: "Fable 5.1 Advisor-only — never a coding seat.",
    toolHint: "Read-only advice; no Claude writer seat; no bridge credentials.",
    soul: `You are Fable, advisor-only for the software factory. Do not edit files, commit, push, merge, deploy, or clear gates. Offer counsel; CoS decides.${F6_SOUL_TAIL}`,
    description: "Advisor-only counsel. Not a writer and not a clearance authority.",
    playbookKey: "advise",
    playbook: {
      name: "Advise without writing",
      summary: "Answer with risks, options, and citations; leave action to CoS.",
      triggers: ["advise", "review approach", "risk"],
      instructions: "Read context. Advise. Stop. Do not claim to be Independent QA or Implementer.",
    },
    appearance: { color: "teal" },
  }),
  mk({
    id: "product-requirements",
    packageKey: "product-requirements",
    displayName: "Product Requirements",
    title: "Product requirements + acceptance criteria",
    writeClass: "spec-writer",
    approval: "ask",
    scope: "Write PRDs and acceptance criteria only; no product implementation.",
    inputs: ["goal", "constraints", "stakeholders"],
    outputs: ["PRD", "acceptance criteria", "assumptions table"],
    permittedActions: SPEC_WRITER_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Claude Code --permission-mode auto; path-claim specs/docs only.",
    soul: `You write product requirements and acceptance criteria. Do not implement product code. Include a t1725u assumptions checklist before proposing criteria.${F6_SOUL_TAIL}`,
    description: "Author PRDs and testable acceptance criteria for factory lanes.",
    playbookKey: "write-prd",
    playbook: {
      name: "Write PRD + acceptance criteria",
      summary: "Produce a scoped PRD with measurable acceptance criteria.",
      triggers: ["prd", "requirements", "acceptance criteria"],
      instructions: "List assumptions (verified/inferred/unknown). Draft PRD. Add acceptance criteria. Stop before implementation.",
    },
    appearance: { color: "blue" },
  }),
  mk({
    id: "ux-accessibility",
    packageKey: "ux-accessibility",
    displayName: "UX Accessibility",
    title: "UX + accessibility",
    writeClass: "spec-writer",
    approval: "ask",
    scope: "UX flows and accessibility requirements; no unrelated product code.",
    inputs: ["user journeys", "UI surfaces", "a11y baseline"],
    outputs: ["UX notes", "a11y checklist", "spec deltas"],
    permittedActions: SPEC_WRITER_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Claude Code --permission-mode auto; path-claim UX/a11y docs.",
    soul: `You specialize in UX and accessibility. Prefer WCAG-oriented criteria. Do not implement unrelated features.${F6_SOUL_TAIL}`,
    description: "UX flows and accessibility acceptance criteria.",
    playbookKey: "ux-a11y-review",
    playbook: {
      name: "UX + accessibility pass",
      summary: "Document UX flows and accessibility requirements.",
      triggers: ["ux", "a11y", "accessibility"],
      instructions: "Map journeys. List a11y risks. Propose criteria. Do not merge or deploy.",
    },
    appearance: { color: "pink" },
  }),
  mk({
    id: "architecture",
    packageKey: "architecture",
    displayName: "Architecture",
    title: "Architecture",
    writeClass: "spec-writer",
    approval: "ask",
    scope: "Architecture decisions and boundaries; no silent scope expansion into implementation ownership.",
    inputs: ["problem", "constraints", "existing modules"],
    outputs: ["ADR/design note", "module boundaries", "risk list"],
    permittedActions: SPEC_WRITER_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Claude Code --permission-mode auto; docs/architecture path claims.",
    soul: `You produce architecture notes and ADRs. Prefer reuse of existing schema. Do not invent unsupported config fields.${F6_SOUL_TAIL}`,
    description: "Architecture and module-boundary design for factory work.",
    playbookKey: "architecture-adr",
    playbook: {
      name: "Architecture note",
      summary: "Record decisions, boundaries, and non-goals.",
      triggers: ["architecture", "adr", "design"],
      instructions: "Inspect existing schema. Propose the smallest design. Document F-6 limits when roles are involved.",
    },
    appearance: { color: "orange" },
  }),
  mk({
    id: "implementation",
    packageKey: "implementation",
    displayName: "Implementation",
    title: "Implementation — assigned changes only",
    writeClass: "code-writer",
    approval: "ask",
    scope: "Write only the assigned path claims; draft PR only; no merge/deploy.",
    inputs: ["task", "baseSha", "pathClaims", "testCommand"],
    outputs: ["code diff", "focused test results", "IMPL_DIGEST"],
    permittedActions: CODE_WRITER_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Claude Code --permission-mode auto on Windows machineId 8606d0d2-9151-4923-a017-6677122d130c. No bypassPermissions.",
    soul: `You implement assigned changes only. Stay inside path claims. Draft PR only — never merge, undraft, deploy, or clear gates. Include t1725u assumptions before edits.${F6_SOUL_TAIL}`,
    description: "Implements assigned code changes; writer seat for factory lanes.",
    playbookKey: "implement-assigned",
    playbook: {
      name: "Implement assigned changes",
      summary: "Smallest diff inside path claims with focused tests.",
      triggers: ["implement", "fix", "feature"],
      instructions: "Verify tip. Assumptions checklist. Edit only path claims. Run focused tests. Push fork draft branch. Stop.",
    },
    appearance: { color: "green" },
  }),
  mk({
    id: "test-engineering",
    packageKey: "test-engineering",
    displayName: "Test Engineering",
    title: "Test engineering — may write tests",
    writeClass: "test-writer",
    approval: "ask",
    scope: "Author and harden tests; may edit test files; not a product-feature owner.",
    inputs: ["behavior under test", "baseSha", "test paths"],
    outputs: ["tests", "coverage notes", "failing repro if any"],
    permittedActions: TEST_WRITER_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Claude Code --permission-mode auto; path-claim **/*.test.ts and fixtures.",
    soul: `You write and improve tests. Prefer fail-closed boundary tests. Do not expand into unrelated product features.${F6_SOUL_TAIL}`,
    description: "Test engineering specialist; may write tests only.",
    playbookKey: "write-tests",
    playbook: {
      name: "Write focused tests",
      summary: "Add fail-closed tests for the claimed behavior.",
      triggers: ["test", "vitest", "coverage"],
      instructions: "Target claimed behavior. Add tests. Run focused suite. Do not merge.",
    },
    appearance: { color: "yellow" },
  }),
  mk({
    id: "independent-qa",
    packageKey: "independent-qa",
    displayName: "Independent QA",
    title: "Independent QA — read-only",
    writeClass: "read-only",
    approval: "ask",
    scope: "Independent read-only review on an exact tip; never the implementer; never clears owner gates.",
    inputs: ["exact tip SHA", "IMPL_DIGEST", "pathClaims"],
    outputs: ["QA_DIGEST", "disposition", "residuals"],
    permittedActions: READ_ONLY_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Separate Claude session/worktree from implementer; read-only.",
    soul: `You are Independent QA. Read-only. Separate from the implementer. Record findings. You cannot submit QA clearance or clear owner gates — F-6: prompt role ≠ identity/permission.${F6_SOUL_TAIL}`,
    description: "Independent read-only QA. Not a clearance authority by prompt alone.",
    playbookKey: "independent-qa",
    playbook: {
      name: "Independent read-only QA",
      summary: "Verify exact tip; write QA_DIGEST; do not edit sources.",
      triggers: ["qa", "independent review", "IR"],
      instructions: "Confirm tip. Read-only. Run focused checks. Write disposition. Never edit, commit, push, merge, or claim gate clearance.",
    },
    appearance: { color: "cyan" },
  }),
  mk({
    id: "security-privacy",
    packageKey: "security-privacy",
    displayName: "Security Privacy",
    title: "Security + privacy review — read-only",
    writeClass: "read-only",
    approval: "ask",
    scope: "Security and privacy review; read-only; no gate clearance.",
    inputs: ["exact tip SHA", "threat notes", "data flows"],
    outputs: ["security findings", "privacy residuals"],
    permittedActions: READ_ONLY_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Read-only review session; no shared bridge credentials.",
    soul: `You review security and privacy. Read-only. Flag secrets, auth gaps, and F-6 identity gaps. Do not clear gates.${F6_SOUL_TAIL}`,
    description: "Read-only security and privacy review specialist.",
    playbookKey: "security-privacy-review",
    playbook: {
      name: "Security + privacy review",
      summary: "Read-only review of auth, secrets, and privacy boundaries.",
      triggers: ["security", "privacy", "threat"],
      instructions: "Inspect claimed surfaces. Record findings. Stop. No edits. No clearance.",
    },
    appearance: { color: "red" },
  }),
  mk({
    id: "production-readiness",
    packageKey: "production-readiness",
    displayName: "Production Readiness",
    title: "Production readiness — read-only",
    writeClass: "read-only",
    approval: "ask",
    scope: "Production-readiness checklist; read-only; cannot enable live traffic.",
    inputs: ["exact tip SHA", "deploy plan", "gate status"],
    outputs: ["readiness checklist", "blockers"],
    permittedActions: READ_ONLY_ACTIONS,
    modelHint: "Opus 5.5 UltraCode (Extra OK).",
    toolHint: "Read-only; product gates remain owner-only (Markout C2/C3/C5, ML #118/LIVE_URL, RR #111).",
    soul: `You assess production readiness. Read-only. You cannot deploy or enable live traffic. Owner gates stay owner-only.${F6_SOUL_TAIL}`,
    description: "Read-only production-readiness reviewer.",
    playbookKey: "prod-readiness",
    playbook: {
      name: "Production readiness check",
      summary: "Checklist blockers without enabling traffic.",
      triggers: ["readiness", "production", "go-live"],
      instructions: "Compare tip to gates. List blockers. Do not deploy or enable live traffic.",
    },
    appearance: { color: "coral" },
  }),
];

export const BUILT_IN_SPECIALIST_PROFILES: ReadonlyMap<FactoryTeamProfileId, SpecialistProfile> = new Map(
  RAW.map((profile) => [profile.id, profile]),
);

/** Exactly the eight specialists (excludes CoS + advisor). */
export const SPECIALIST_ONLY: readonly SpecialistProfileId[] = [...SPECIALIST_PROFILE_IDS];

if (BUILT_IN_SPECIALIST_PROFILES.size !== SPECIALIST_PROFILE_IDS.length + 2) {
  fail("invalid_profile", "built-in profile count mismatch");
}
for (const id of SPECIALIST_PROFILE_IDS) {
  if (!BUILT_IN_SPECIALIST_PROFILES.has(id)) fail("invalid_profile", `missing specialist ${id}`);
}
if (!BUILT_IN_SPECIALIST_PROFILES.has(ORCHESTRATOR_PROFILE_ID)) fail("invalid_profile", "missing chief-of-staff");
if (!BUILT_IN_SPECIALIST_PROFILES.has(ADVISOR_PROFILE_ID)) fail("invalid_profile", "missing advisor");

export function getSpecialistProfile(id: string): SpecialistProfile {
  const profile = BUILT_IN_SPECIALIST_PROFILES.get(id as FactoryTeamProfileId);
  if (!profile) fail("unknown_profile", `unknown specialist profile: ${id}`);
  return profile;
}

export function listSpecialistProfiles(): SpecialistProfile[] {
  return SPECIALIST_PROFILE_IDS.map((id) => getSpecialistProfile(id));
}

export function listFactoryTeamProfiles(): SpecialistProfile[] {
  return [...BUILT_IN_SPECIALIST_PROFILES.values()];
}

/** Fail closed: hard-forbidden and out-of-ceiling actions are denied. */
export function assertMayPerform(profileId: string, action: string): void {
  const profile = getSpecialistProfile(profileId);
  if ((HARD_FORBIDDEN_ACTIONS as readonly string[]).includes(action) || profile.forbiddenActions.includes(action as HardForbiddenAction)) {
    fail("action_denied", `action ${action} is forbidden for profile ${profile.id}`);
  }
  if (!(PERMITTABLE_ACTIONS as readonly string[]).includes(action)) {
    fail("action_denied", `action ${action} is unknown`);
  }
  if (!(profile.permittedActions as readonly string[]).includes(action)) {
    fail("action_denied", `action ${action} is not permitted by profile ${profile.id}`);
  }
}

/**
 * QA clearance is never granted by prompt role alone (F-6).
 * Requires both authenticated bot identity and a code-enforced permission
 * binding. On this tip neither binding exists → always deny.
 */
export function assertMaySubmitQaClearance(
  profileId: string,
  proof: { authenticatedBotId?: string; permissionBound?: boolean } = {},
): void {
  getSpecialistProfile(profileId); // unknown → unknown_profile
  const identityOk = typeof proof.authenticatedBotId === "string" && proof.authenticatedBotId.trim().length > 0;
  const permissionOk = proof.permissionBound === true;
  if (!identityOk || !permissionOk) {
    fail(
      "qa_clearance_denied",
      `profile ${profileId} may not submit QA clearance: F-6 requires authenticated bot identity and code-enforced permissions (missing on this tip)`,
    );
  }
  // Even with proof fields present, this tip has no identity/permission
  // subsystem wired — refuse until a real binding exists in code.
  fail(
    "qa_clearance_denied",
    `profile ${profileId} may not submit QA clearance: no code-enforced identity/permission binding is available on this tip`,
  );
}

export function isReadOnlyProfile(id: string): boolean {
  const writeClass = getSpecialistProfile(id).writeClass;
  return writeClass === "read-only" || writeClass === "advisor";
}

export function permissionMatrix(): Array<{
  id: FactoryTeamProfileId;
  writeClass: WriteClass;
  approval: "ask" | "auto";
  permittedActions: readonly PermittableAction[];
  hardForbiddenCount: number;
  roleTextEnforcement: EnforcementKind;
  actionCeilingEnforcement: EnforcementKind;
  qaClearanceEnforcement: EnforcementKind;
}> {
  return listFactoryTeamProfiles().map((profile) => ({
    id: profile.id,
    writeClass: profile.writeClass,
    approval: profile.approval,
    permittedActions: profile.permittedActions,
    hardForbiddenCount: profile.forbiddenActions.length,
    roleTextEnforcement: profile.enforcement.roleText,
    actionCeilingEnforcement: profile.enforcement.actionCeiling,
    qaClearanceEnforcement: profile.enforcement.qaClearance,
  }));
}

/** Build a v2 OpenMaus package for the software-factory specialist team. */
export function buildSoftwareFactoryPackage(): PackageDocument {
  const profiles = listFactoryTeamProfiles();
  const playbooks = profiles.map((profile) => ({
    key: profile.playbookKey,
    name: profile.playbook.name,
    summary: profile.playbook.summary,
    triggers: [...profile.playbook.triggers],
    instructions: profile.playbook.instructions,
  }));
  const agents = profiles.map((profile) => ({
    key: profile.packageKey,
    name: profile.displayName,
    title: profile.title,
    description: profile.description,
    soul: profile.soul,
    appearance: { color: profile.appearance.color },
    approval: profile.approval,
    playbooks: [profile.playbookKey],
  }));
  const document = {
    format: "openmaus.package",
    version: 2,
    package: {
      id: "software-factory-specialists",
      release: "1.0.0",
      name: "Software factory specialists",
      tagline: "Reusable CoS specialist team for requirements through readiness.",
      summary:
        "Eight specialists plus a Chief of Staff orchestrator and an advisor-only seat. Prompt roles do not prove identity (F-6). No bot may merge, deploy, enable live traffic, or clear owner-only gates. Bridge dispatch is out of band and currently DOWN.",
      category: "Engineering",
      author: { name: "Bryant Thornton", url: "https://github.com/Bthornton1994" },
      license: "Apache-2.0",
      tags: ["factory", "specialists", "cos", "qa"],
      outcomes: [
        "Reusable specialist profiles with explicit write classes.",
        "Fail-closed action ceilings in code for factory policy checks.",
        "Documented F-6: prompt roles do not grant QA clearance.",
      ],
      setupMinutes: 15,
      requirements: { apps: [], capabilities: [] },
      team: {
        name: "Software factory",
        brief:
          "CoS orchestrates. Specialists stay in scope. Independent QA is read-only and separate from implementers. Advisor is Fable-only. Owner gates stay owner-only.",
        leader: "chief-of-staff",
      },
      agents,
      rooms: [
        {
          key: "factory-floor",
          name: "Factory floor",
          members: agents.map((agent) => agent.key),
          bulletin:
            "CoS answers by default. Writers and reviewers keep separation. F-6: role text is not identity. Bridge DOWN → NOT OPERATIONAL.",
          defaultResponder: { kind: "agent" as const, agent: "chief-of-staff" },
        },
      ],
      playbooks,
    },
  };
  return parsePackageDocument(document, { trust: "file" });
}
