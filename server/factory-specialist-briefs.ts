// Factory specialist briefs — five read-only reviewer briefs for the software
// factory: codebase navigator, security and privacy, UI and accessibility,
// game and interaction design (StageForge, Loadout), and release readiness.
//
// Each brief keeps the factory task-pattern v1 fields (id, version, role,
// objective, inputs, steps, permittedTools, permittedActions,
// forbiddenActions, expectedArtifact, stopConditions) and adds what a
// reviewer needs on top: when to use it, keyed evidence requirements, report
// outcomes and sections, uncertainty rules, and a completion condition.
//
// The task-pattern catalog (server/factory-task-patterns.ts) and the
// specialist profiles are on draft PRs, not on main, so this module imports
// neither; their action lists are written out here, the way the profiles
// module does for the same reason. The implementer, independent QA, and
// completion-report patterns are not part of this module and are unchanged.
//
// Data, validation, and rendering only: no bots, packages, routes, model
// routing, bridge, or lanes. Briefs are read-only by construction. The
// reviewer action ceiling has no edit, commit, push, approval, merge, deploy,
// flag, gate, readiness, or QA-disposition action, and every brief must
// forbid all of those. A report outcome is never a pass, approval, or
// clearance. Everything fails closed with SpecialistBriefError.

export const SPECIALIST_BRIEF_FORMAT_VERSION = 1;

export type SpecialistBriefErrorCode =
  | "unknown_brief"
  | "invalid_brief"
  | "action_denied"
  | "invalid_vars"
  | "invalid_report"
  | "evidence_missing";

export class SpecialistBriefError extends Error {
  readonly code: SpecialistBriefErrorCode;
  constructor(code: SpecialistBriefErrorCode, message: string) {
    super(message);
    this.name = "SpecialistBriefError";
    this.code = code;
  }
}

const fail = (code: SpecialistBriefErrorCode, message: string): never => {
  throw new SpecialistBriefError(code, message);
};

// ── action vocabulary ─────────────────────────────────────────────────

/** Everything a reviewer brief may permit. None of these changes a repo, a
 * PR, a deployment, a flag, a gate, or a lane. */
export const REVIEWER_ACTIONS = [
  "read-repo",
  "read-lane",
  "run-tests",
  "run-typecheck",
  "inspect-ui",
  "read-ci-status",
  "read-deploy-status",
  "record-findings",
  "report-status",
] as const;

/** Every reviewer brief must forbid all of these. */
export const REVIEWER_FORBIDDEN_ACTIONS = [
  // factory-task-patterns HARD_FORBIDDEN_ACTIONS
  "grant-permissions",
  "clear-project-gates",
  "override-eligibility",
  "override-protect",
  "merge",
  "undraft",
  "push-upstream",
  "install-fabric",
  "add-model-provider",
  "change-routing",
  "print-secrets",
  // factory-specialist-profiles additions
  "deploy",
  "enable-live-traffic",
  "submit-qa-clearance",
  // read-only reviewer
  "edit-files",
  "commit",
  "push-fork",
  "approve-pr",
  "set-product-flags",
  "clear-owner-gates",
  "claim-production-readiness",
  "record-qa-disposition",
  "give-legal-advice",
  "attest-for-owner",
] as const;

export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];
export type ReviewerForbiddenAction = (typeof REVIEWER_FORBIDDEN_ACTIONS)[number];

// ── labels and outcomes ───────────────────────────────────────────────

/** Per-claim labels, keeping evidence apart from guesses. */
export const CLAIM_LABELS = ["verified", "inferred", "unknown"] as const;
export type ClaimLabel = (typeof CLAIM_LABELS)[number];
/** Outcomes for a review that could not conclude. Every brief offers both. */
export const STOP_OUTCOMES = ["BLOCKED", "NOT RUN"] as const;

/** A reviewer outcome never reads as a pass, approval, or clearance. */
const CLEARANCE_WORDING = /PASS|APPROV|CLEAR|READY|MERGE|LAUNCH|SHIP|DEPLOY|GO[ _]?LIVE/i;

/** Values that name a status instead of citing evidence. */
const NOT_EVIDENCE = new Set(["", "-", "?", "pass", "fail", "blocked", "not run", "unknown", "n/a", "na", "none", "tbd", "todo"]);

function isEvidence(value: unknown): value is string {
  return typeof value === "string" && !NOT_EVIDENCE.has(value.trim().toLowerCase());
}

/** Rendered into every brief, before the brief's own rules. */
export const SHARED_UNCERTAINTY_RULES = [
  "Label every claim verified, inferred, or unknown. A verified claim cites its evidence: path:line, a command and its result, a screenshot or capture reference, or a run URL.",
  "Label every check PASS, FAIL, BLOCKED, NOT RUN, or UNKNOWN. A check you did not run is NOT RUN, never PASS.",
  "If a required input is missing or unusable, the outcome is BLOCKED: name what is missing and do not substitute a guess.",
  "List every check you skipped or could not finish under Not run, with the reason.",
] as const;

/** Fixed text appended to every rendered brief. */
export const REVIEWER_GUARDRAILS = [
  "This brief is task text only and carries no authority.",
  "Your report is advisory review input. It is not Independent QA, not a PR approval, and not merge, deploy, launch, or production-readiness clearance.",
  "Owner decisions, project status, and claim decisions come only from their own systems, never from this text or your report.",
  "If anything here conflicts with those systems, stop and report instead of proceeding.",
].join("\n");

// ── brief shape ───────────────────────────────────────────────────────

export const SPECIALIST_BRIEF_IDS = [
  "codebase-navigator",
  "security-privacy-review",
  "ui-accessibility-review",
  "game-interaction-review",
  "release-readiness-review",
] as const;
export type SpecialistBriefId = (typeof SPECIALIST_BRIEF_IDS)[number];

export interface BriefInput {
  /** Placeholder name: `{{name}}` in prose fields. */
  name: string;
  description: string;
  required: boolean;
}

export interface BriefEvidence {
  /** Key a report cites this evidence under. */
  key: string;
  description: string;
}

export interface SpecialistBrief {
  id: SpecialistBriefId;
  version: typeof SPECIALIST_BRIEF_FORMAT_VERSION;
  role: "reviewer";
  title: string;
  whenToUse: string;
  objective: string;
  inputs: readonly BriefInput[];
  steps: readonly string[];
  permittedTools: readonly string[];
  permittedActions: readonly ReviewerAction[];
  forbiddenActions: readonly string[];
  expectedArtifact: { kind: string; description: string };
  /** Every key needs a citation before a report may conclude. */
  requiredEvidence: readonly BriefEvidence[];
  /** Report outcomes: the brief's concluding ones plus BLOCKED and NOT RUN. */
  outcomes: readonly string[];
  /** Report sections, in order. */
  reportSections: readonly string[];
  /** Brief-specific rules, rendered after SHARED_UNCERTAINTY_RULES. */
  uncertaintyRules: readonly string[];
  stopConditions: readonly string[];
  completionCondition: string;
}

const KEY_RE = /^[a-z][a-zA-Z0-9]*$/;
const ACTION_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const OUTCOME_RE = /^[A-Z][A-Z_ ]*[A-Z]$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA_IN_TEXT_RE = /\b[0-9a-f]{40}\b/;
const PLACEHOLDER_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
const MAX_VAR = 4000;

// ── validation ────────────────────────────────────────────────────────

function text(where: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid_brief", `${where} must be a non-empty string`);
  return value as string;
}

function textList(where: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_brief", `${where} must be a non-empty list`);
  return (value as unknown[]).map((item, index) => text(`${where}[${index}]`, item));
}

function unique(where: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail("invalid_brief", `${where} has duplicates`);
}

/** Every free-text field, labelled. Action ids and outcomes are structural. */
function proseFields(brief: SpecialistBrief): Array<[string, string]> {
  return [
    ["title", brief.title],
    ["whenToUse", brief.whenToUse],
    ["objective", brief.objective],
    ...brief.inputs.map((input, i): [string, string] => [`inputs[${i}].description`, input.description]),
    ...brief.steps.map((step, i): [string, string] => [`steps[${i}]`, step]),
    ...brief.permittedTools.map((tool, i): [string, string] => [`permittedTools[${i}]`, tool]),
    ["expectedArtifact.kind", brief.expectedArtifact.kind],
    ["expectedArtifact.description", brief.expectedArtifact.description],
    ...brief.requiredEvidence.map((item, i): [string, string] => [`requiredEvidence[${i}]`, item.description]),
    ...brief.reportSections.map((item, i): [string, string] => [`reportSections[${i}]`, item]),
    ...brief.uncertaintyRules.map((item, i): [string, string] => [`uncertaintyRules[${i}]`, item]),
    ...brief.stopConditions.map((item, i): [string, string] => [`stopConditions[${i}]`, item]),
    ["completionCondition", brief.completionCondition],
  ];
}

/** Check a brief and return a frozen copy. Throws SpecialistBriefError when
 * it is not a catalog id, permits anything outside the reviewer ceiling,
 * drops a forbidden action, offers a pass- or clearance-like outcome, lacks
 * BLOCKED or NOT RUN, or uses an undeclared placeholder. */
export function validateSpecialistBrief(brief: SpecialistBrief): SpecialistBrief {
  if (!brief || typeof brief !== "object") fail("invalid_brief", "brief must be an object");
  const where = `brief ${JSON.stringify(brief.id)}:`;
  if (!(SPECIALIST_BRIEF_IDS as readonly string[]).includes(brief.id)) fail("invalid_brief", `${where} id is not in the catalog`);
  if (brief.version !== SPECIALIST_BRIEF_FORMAT_VERSION) fail("invalid_brief", `${where} version must be ${SPECIALIST_BRIEF_FORMAT_VERSION}`);
  if (brief.role !== "reviewer") fail("invalid_brief", `${where} role must be reviewer`);

  for (const field of ["title", "whenToUse", "objective", "completionCondition"] as const) text(`${where} ${field}`, brief[field]);
  for (const field of ["steps", "permittedTools", "reportSections", "uncertaintyRules", "stopConditions"] as const) {
    textList(`${where} ${field}`, brief[field]);
  }
  if (!brief.expectedArtifact || typeof brief.expectedArtifact !== "object") fail("invalid_brief", `${where} expectedArtifact must be an object`);
  text(`${where} expectedArtifact.kind`, brief.expectedArtifact.kind);
  text(`${where} expectedArtifact.description`, brief.expectedArtifact.description);

  if (!Array.isArray(brief.inputs) || !brief.inputs.some((input) => input?.required === true)) {
    fail("invalid_brief", `${where} needs at least one required input`);
  }
  for (const [index, input] of brief.inputs.entries()) {
    if (typeof input?.name !== "string" || !KEY_RE.test(input.name)) fail("invalid_brief", `${where} inputs[${index}].name must be alphanumeric`);
    text(`${where} inputs[${index}].description`, input.description);
    if (typeof input.required !== "boolean") fail("invalid_brief", `${where} inputs[${index}].required must be a boolean`);
  }
  unique(`${where} inputs`, brief.inputs.map((input) => input.name));

  if (!Array.isArray(brief.requiredEvidence) || brief.requiredEvidence.length === 0) {
    fail("invalid_brief", `${where} requiredEvidence must be a non-empty list`);
  }
  for (const [index, item] of brief.requiredEvidence.entries()) {
    if (typeof item?.key !== "string" || !KEY_RE.test(item.key)) fail("invalid_brief", `${where} requiredEvidence[${index}].key must be alphanumeric`);
    text(`${where} requiredEvidence[${index}].description`, item.description);
  }
  unique(`${where} requiredEvidence`, brief.requiredEvidence.map((item) => item.key));

  // Outcomes: BLOCKED and NOT RUN always, at least one concluding outcome,
  // and nothing that reads as a pass, approval, or clearance.
  const outcomes = textList(`${where} outcomes`, brief.outcomes);
  unique(`${where} outcomes`, outcomes);
  for (const outcome of outcomes) {
    if (!OUTCOME_RE.test(outcome)) fail("invalid_brief", `${where} outcome ${JSON.stringify(outcome)} must be upper case`);
    if (CLEARANCE_WORDING.test(outcome)) fail("invalid_brief", `${where} outcome ${outcome} reads as a pass or clearance`);
  }
  const missingStops = STOP_OUTCOMES.filter((outcome) => !outcomes.includes(outcome));
  if (missingStops.length) fail("invalid_brief", `${where} outcomes must include ${missingStops.join(", ")}`);
  if (outcomes.length === STOP_OUTCOMES.length) fail("invalid_brief", `${where} needs a concluding outcome`);

  // Actions: within the reviewer ceiling, and the full deny list present.
  const permitted = textList(`${where} permittedActions`, brief.permittedActions);
  const forbidden = textList(`${where} forbiddenActions`, brief.forbiddenActions);
  unique(`${where} permittedActions`, permitted);
  unique(`${where} forbiddenActions`, forbidden);
  for (const action of [...permitted, ...forbidden]) {
    if (!ACTION_RE.test(action)) fail("invalid_brief", `${where} action ${JSON.stringify(action)} must be kebab-case`);
  }
  const unlisted = REVIEWER_FORBIDDEN_ACTIONS.filter((action) => !forbidden.includes(action));
  if (unlisted.length) fail("action_denied", `${where} forbiddenActions must include ${unlisted.join(", ")}`);
  for (const action of permitted) {
    if (forbidden.includes(action)) fail("action_denied", `${where} permits forbidden action ${action}`);
    if (!(REVIEWER_ACTIONS as readonly string[]).includes(action)) fail("action_denied", `${where} reviewer may not permit ${action}`);
  }

  const declared = new Set(brief.inputs.map((input) => input.name));
  for (const [label, value] of proseFields(brief)) {
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      if (!declared.has(match[1])) fail("invalid_brief", `${where} ${label} uses undeclared placeholder {{${match[1]}}}`);
    }
  }
  return deepFreeze(structuredClone(brief));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ── built-ins ─────────────────────────────────────────────────────────

const FORBIDDEN = [...REVIEWER_FORBIDDEN_ACTIONS];

const SHA_INPUT_DESCRIPTION = "Full 40-hex commit SHA. Every path and line cites this commit.";

const RAW_BRIEFS: SpecialistBrief[] = [
  {
    id: "codebase-navigator",
    version: 1,
    role: "reviewer",
    title: "Codebase navigator",
    whenToUse:
      "Before planning or reviewing a change, when someone needs a map of where a behavior lives: entry points, flows, tests, and docs, on an exact commit.",
    objective: "Map {{question}} in {{repo}} at {{sha}}: entry points, flows, tests, and docs, with evidence kept apart from guesses.",
    inputs: [
      { name: "question", description: "The behavior, feature, or question to map, in one or two sentences.", required: true },
      { name: "repo", description: "owner/name of the repository.", required: true },
      { name: "sha", description: SHA_INPUT_DESCRIPTION, required: true },
      { name: "scopeHint", description: "Directories or files to start from, if known.", required: false },
    ],
    steps: [
      "Read {{repo}} at exactly {{sha}} and record the SHA you read.",
      "Find the entry points for {{question}} (routes, commands, exported functions, UI handlers) and cite each as path:line. Start from {{scopeHint}} when given.",
      "Trace each flow from entry point to effect, citing path:line at every hop. Where a hop is a guess (dynamic dispatch, string lookup, config), label it inferred and say why.",
      "List the tests that cover each flow by file and test name. Run the focused ones when cheap and label each run PASS, FAIL, or NOT RUN with its command.",
      "List the docs that describe the behavior and note where a doc disagrees with the code.",
      "Return the map. Fixes and plans are for the requester.",
    ],
    permittedTools: ["git, read-only (show, log, grep, blame)", "file read and search", "pnpm exec vitest, focused", "pnpm typecheck"],
    permittedActions: ["read-repo", "read-lane", "run-tests", "run-typecheck", "record-findings", "report-status"],
    forbiddenActions: FORBIDDEN,
    expectedArtifact: {
      kind: "codebase-map",
      description: "Entry points, flows, tests, and docs for {{question}} at {{sha}}, each claim labelled verified, inferred, or unknown.",
    },
    requiredEvidence: [
      { key: "reviewedSha", description: "The exact SHA read; it must equal the sha input." },
      { key: "entryPoints", description: "Each entry point as path:line." },
      { key: "flows", description: "Each flow as a chain of path:line hops." },
      { key: "tests", description: "Test files and names per flow, with the command and PASS, FAIL, or NOT RUN for any run." },
      { key: "docs", description: "Doc paths that describe the behavior, or the searches that found none." },
    ],
    outcomes: ["MAPPED", "BLOCKED", "NOT RUN"],
    reportSections: [
      "Reviewed SHA",
      "Entry points (verified, path:line)",
      "Flows (each hop labelled)",
      "Tests",
      "Docs",
      "Inferred and unknown, each with what would confirm it",
      "Not run",
    ],
    uncertaintyRules: [
      "A path, symbol, or line you did not open at {{sha}} is unknown, not verified.",
      "Never present a likely file name or convention as a found path. Search first; if nothing is found, list the searches that ran.",
    ],
    stopConditions: [
      "The checkout is not {{sha}}, or the SHA moves while you read.",
      "{{repo}} at {{sha}} cannot be read.",
      "Answering needs an edit, a build that writes tracked files, or network access beyond reading the repo.",
    ],
    completionCondition:
      "Done when every entry point, flow hop, test, and doc in the report is either verified with a path:line or command citation at {{sha}} or labelled inferred or unknown with what would confirm it, and the outcome is MAPPED. Otherwise the outcome is BLOCKED or NOT RUN with what is missing.",
  },
  {
    id: "security-privacy-review",
    version: 1,
    role: "reviewer",
    title: "Security and privacy reviewer",
    whenToUse:
      "When a change touches auth, secrets, untrusted input, file or network access, logging, or personal data, and a review of reproducible technical risks is wanted on an exact commit.",
    objective: "Review {{surface}} in {{repo}} at {{sha}} for reproducible security and privacy risks, each backed by evidence.",
    inputs: [
      { name: "surface", description: "The change, files, or feature to review: a diff range, paths, or a PR link.", required: true },
      { name: "repo", description: "owner/name of the repository.", required: true },
      { name: "sha", description: SHA_INPUT_DESCRIPTION, required: true },
      { name: "threatNotes", description: "Known threats, data flows, or earlier findings to check.", required: false },
    ],
    steps: [
      "Read {{repo}} at exactly {{sha}} and record the SHA you read.",
      "List the trust boundaries in {{surface}}: who supplies each input, what it can reach, and what data leaves. Include {{threatNotes}} when given.",
      "Reproduce each candidate risk locally with a failing test, a command, or exact steps and the observed result. Use only local fixtures and test data.",
      "Describe each reproduced risk by technical impact and likelihood, with path:line.",
      "Keep risks you could not reproduce in a separate list labelled inferred or unknown, with what would confirm them.",
      "Return the findings. Fixes are for the implementer.",
    ],
    permittedTools: ["git, read-only", "file read and search", "pnpm exec vitest, focused, local fixtures only", "pnpm typecheck"],
    permittedActions: ["read-repo", "read-lane", "run-tests", "run-typecheck", "record-findings", "report-status"],
    forbiddenActions: FORBIDDEN,
    expectedArtifact: {
      kind: "security-privacy-findings",
      description: "Reproduced risks with path:line, reproduction, observed result, and technical impact; unconfirmed risks listed apart.",
    },
    requiredEvidence: [
      { key: "reviewedSha", description: "The exact SHA reviewed; it must equal the sha input." },
      { key: "surfacesReviewed", description: "Files, routes, and data flows actually read, as paths." },
      { key: "checksRun", description: "Each reproduction or check: the command or steps and the observed result, labelled PASS, FAIL, or NOT RUN." },
    ],
    outcomes: ["FINDINGS", "NO_FINDINGS", "BLOCKED", "NOT RUN"],
    reportSections: [
      "Reviewed SHA and scope",
      "Trust boundaries",
      "Reproduced risks (verified)",
      "Unconfirmed risks (inferred or unknown)",
      "Not reviewed",
      "Not run",
    ],
    uncertaintyRules: [
      "A risk without a local reproduction is inferred, not verified.",
      "NO_FINDINGS covers only the surfaces and checks listed. Name what was not reviewed.",
      "Report technical risk only. Legal or regulatory conclusions and attestations on the owner's behalf are out of scope; name the open question for the owner instead.",
    ],
    stopConditions: [
      "The checkout is not {{sha}}, or the SHA moves during review.",
      "Reproducing a risk would need production systems, real user data, live credentials, or third-party targets: report it unconfirmed instead.",
      "A secret or personal data appears in output: stop, refer to it by location only, and report.",
    ],
    completionCondition:
      "Done when every part of {{surface}} is listed as reviewed or not reviewed, every verified risk has a local reproduction with its observed result and path:line, and the outcome is FINDINGS or NO_FINDINGS. Otherwise the outcome is BLOCKED or NOT RUN with what is missing.",
  },
  {
    id: "ui-accessibility-review",
    version: 1,
    role: "reviewer",
    title: "UI and accessibility reviewer",
    whenToUse:
      "When a change alters what people see or operate, and a running interface or supplied screenshots are available to inspect.",
    objective: "Review {{surface}} for UI and accessibility problems by inspecting {{interfaceSource}}.",
    inputs: [
      { name: "surface", description: "Screens, components, or flows to review.", required: true },
      {
        name: "interfaceSource",
        description: "A running local or preview URL with the build SHA it serves, or the paths of supplied screenshots. Production URLs are out of scope.",
        required: true,
      },
      { name: "sha", description: "Full 40-hex commit SHA the interface was built from, if known.", required: false },
      { name: "acceptanceCriteria", description: "UX or accessibility criteria to check against.", required: false },
    ],
    steps: [
      "Open {{interfaceSource}} and confirm you can see {{surface}}. If you cannot load or view it, stop with outcome BLOCKED.",
      "Exercise each state in scope: default, empty, loading, error, long text, narrow and wide viewports, and light and dark themes where offered.",
      "Check keyboard reach and order, visible focus, accessible names and labels, contrast, text scaling, and reduced motion where the source allows. Check {{acceptanceCriteria}} when given.",
      "Record each problem with the screen and state, what you did, what you saw, a screenshot or DOM reference, and the WCAG criterion when one applies.",
      "Mark every check this source cannot support as NOT RUN.",
    ],
    permittedTools: ["browser on a local or preview build", "supplied screenshots", "browser accessibility inspector", "file read"],
    permittedActions: ["read-repo", "read-lane", "inspect-ui", "record-findings", "report-status"],
    forbiddenActions: FORBIDDEN,
    expectedArtifact: {
      kind: "ui-accessibility-findings",
      description: "Problems per screen and state with reproduction, observed result, and evidence reference; checks not performed listed as NOT RUN.",
    },
    requiredEvidence: [
      { key: "interfaceInspected", description: "The URL and build SHA, or the screenshot paths, actually viewed." },
      { key: "statesExercised", description: "Each screen, state, viewport, and theme inspected." },
      { key: "accessibilityChecks", description: "Each accessibility check with PASS, FAIL, or NOT RUN and how it was done." },
    ],
    outcomes: ["FINDINGS", "NO_FINDINGS", "BLOCKED", "NOT RUN"],
    reportSections: [
      "Interface inspected",
      "States exercised",
      "Findings (verified, with evidence reference)",
      "Accessibility checks",
      "Inferred and unknown",
      "Not run",
    ],
    uncertaintyRules: [
      "If you cannot inspect the interface, the outcome is BLOCKED. Reading source code or a description is not a visual review.",
      "Screenshots cannot show keyboard use, focus order, screen reader output, or motion. Those checks are NOT RUN unless a running interface was used.",
      "NO_FINDINGS covers only the states listed under States exercised.",
    ],
    stopConditions: [
      "{{interfaceSource}} does not load, or the screenshots are missing or unreadable.",
      "Reaching the interface needs production data, real accounts, or credentials.",
      "The build changes during review: report NOT RUN for unfinished checks.",
    ],
    completionCondition:
      "Done when each screen and state in {{surface}} was viewed from {{interfaceSource}} with its findings or none recorded, every accessibility check is PASS, FAIL, or NOT RUN with how it was done, and the outcome is FINDINGS or NO_FINDINGS. If nothing could be viewed, the outcome is BLOCKED.",
  },
  {
    id: "game-interaction-review",
    version: 1,
    role: "reviewer",
    title: "Game and interaction design reviewer",
    whenToUse:
      "For StageForge and Loadout, when a playable build, the current vision, and approved references are all available and the question is how the game plays, not how a still image looks.",
    objective: "Review how {{product}} build {{build}} plays for {{focus}}, against the current vision {{visionRef}} and the approved references {{references}}.",
    inputs: [
      { name: "product", description: "StageForge or Loadout.", required: true },
      { name: "build", description: "A playable local or preview build and its SHA or build id.", required: true },
      { name: "visionRef", description: "Path and version of the current vision document.", required: true },
      { name: "references", description: "The approved references (paths or links) the review may compare against.", required: true },
      { name: "focus", description: "Interactions, mechanics, or flows to review.", required: true },
      { name: "playtestNotes", description: "Earlier playtest notes or known issues.", required: false },
    ],
    steps: [
      "Read {{visionRef}} and {{references}} and record their versions. If either is missing or unreadable, stop with outcome BLOCKED.",
      "Launch {{build}} and confirm it runs. If it does not, stop with outcome BLOCKED.",
      "Play each interaction in {{focus}} with real inputs. Record the input sequence, what happened, timing and feedback, and a capture reference. Check {{playtestNotes}} when given.",
      "Compare each observation with a specific line of {{visionRef}} or a specific approved reference, and cite it.",
      "Where the vision and references are silent, record an open question for the owner instead of a requirement.",
      "Return the findings. Design changes are for the owner and implementers.",
    ],
    permittedTools: ["local or preview game build", "input devices or scripted local input", "screen capture", "file read"],
    permittedActions: ["read-repo", "read-lane", "inspect-ui", "record-findings", "report-status"],
    forbiddenActions: FORBIDDEN,
    expectedArtifact: {
      kind: "interaction-review",
      description: "Observed interactions with input sequence, result, and capture reference, each tied to a cited vision line or reference, plus open questions.",
    },
    requiredEvidence: [
      { key: "buildInspected", description: "The build id or SHA actually played and how it was launched." },
      { key: "visionRef", description: "The vision document path and version read." },
      { key: "referencesRead", description: "Each approved reference actually read." },
      { key: "interactionsExercised", description: "Each interaction played, with its input sequence and capture reference." },
    ],
    outcomes: ["FINDINGS", "NO_FINDINGS", "BLOCKED", "NOT RUN"],
    reportSections: [
      "Build and sources",
      "Interactions exercised",
      "Findings, each tied to a vision line or reference",
      "Open questions for the owner",
      "Not run",
    ],
    uncertaintyRules: [
      "Static appearance (screenshots, mockups, art) is not an interaction review. Without a playable build the outcome is BLOCKED.",
      "A finding without a cited vision line or reference is an open question, not a requirement.",
      "Do not fill gaps in the vision with genre conventions or personal taste.",
    ],
    stopConditions: [
      "The build does not launch, or the vision or approved references are missing.",
      "Reaching the build needs production servers, real player data, or store accounts.",
      "The build changes during review: report NOT RUN for unfinished interactions.",
    ],
    completionCondition:
      "Done when every interaction in {{focus}} was played on {{build}} with its input sequence and capture recorded, each finding cites a line of {{visionRef}} or an approved reference, uncited gaps are listed as open questions, and the outcome is FINDINGS or NO_FINDINGS. Otherwise the outcome is BLOCKED or NOT RUN.",
  },
  {
    id: "release-readiness-review",
    version: 1,
    role: "reviewer",
    title: "Release-readiness reviewer",
    whenToUse:
      "When the owner wants one reconciled view of where a change stands before their own merge or launch decision: exact-SHA CI, Independent QA, deployment state, and launch gates.",
    objective: "Reconcile CI, Independent QA, deployment state, and launch gates for {{repo}} at {{sha}} into one report for the owner.",
    inputs: [
      { name: "repo", description: "owner/name of the repository.", required: true },
      { name: "sha", description: "Full 40-hex SHA the release would ship.", required: true },
      { name: "ciSource", description: "Where to read CI results: a run URL or the check list for the SHA.", required: true },
      { name: "qaRecord", description: "Where the Independent QA disposition is recorded: a lane id or digest path.", required: true },
      { name: "deployTarget", description: "Environments whose deployment state to read.", required: true },
      { name: "launchGates", description: "The launch gates to report and where each one's state is recorded.", required: true },
      { name: "prUrl", description: "PR URL, if one exists.", required: false },
    ],
    steps: [
      "Confirm {{sha}} is the exact commit under consideration and record it.",
      "Read CI from {{ciSource}} for exactly {{sha}}: run id, attempt, and conclusion per required check. A run on any other SHA does not count.",
      "Read the Independent QA disposition from {{qaRecord}}: the disposition verbatim, the reviewer, and the SHA reviewed.",
      "Read the deployment state of {{deployTarget}}: which SHA or ref each environment serves.",
      "Read each gate in {{launchGates}}: its recorded state, who decides it, and where that is recorded.",
      "Reconcile: list every mismatch (different SHAs, missing runs, stale QA, gates without a recorded decision) and report each source verbatim, with {{prUrl}} when given.",
    ],
    permittedTools: ["git, read-only", "CI run and check status, read-only", "factory lane read", "deployment status, read-only"],
    permittedActions: ["read-repo", "read-lane", "read-ci-status", "read-deploy-status", "record-findings", "report-status"],
    forbiddenActions: FORBIDDEN,
    expectedArtifact: {
      kind: "release-reconciliation",
      description: "Per-source state for {{sha}} (CI, Independent QA, deployment, each launch gate) reported verbatim, with every mismatch and missing record listed.",
    },
    requiredEvidence: [
      { key: "reviewedSha", description: "The exact SHA reconciled." },
      { key: "ciRun", description: "CI run id, attempt, and conclusion for exactly that SHA." },
      { key: "qaDisposition", description: "The Independent QA disposition verbatim, with its reviewer and reviewed SHA." },
      { key: "deploymentState", description: "Each environment and the SHA or ref it serves, with where that was read." },
      { key: "launchGates", description: "Each gate, its recorded state, and who decides it." },
    ],
    outcomes: ["RECONCILED", "MISMATCH", "BLOCKED", "NOT RUN"],
    reportSections: [
      "SHA",
      "CI on that exact SHA",
      "Independent QA, verbatim",
      "Deployment state",
      "Launch gates",
      "Mismatches and missing records",
      "Decisions left to the owner",
    ],
    uncertaintyRules: [
      "Report the QA disposition exactly as recorded. PASS_KEEP_DRAFT stays PASS_KEEP_DRAFT; this report never restates it as merge or launch readiness.",
      "RECONCILED only means the four sources were read for the same SHA. It is not merge, launch, or production-readiness clearance, and it does not replace Independent QA.",
      "A missing QA disposition is reported as missing. This review does not stand in for it.",
      "CI results on a different SHA, or a run you cannot see, are mismatches or missing records, not passes.",
    ],
    stopConditions: [
      "A source cannot be read: report BLOCKED and name the source.",
      "Reading a source would need write access, a deploy, or credentials beyond read-only status.",
      "The SHA under consideration changes during review: report NOT RUN.",
    ],
    completionCondition:
      "Done when CI, Independent QA, deployment state, and every gate in {{launchGates}} were read for exactly {{sha}} and reported verbatim with their source, every mismatch is listed, and the outcome is RECONCILED or MISMATCH. If any source could not be read, the outcome is BLOCKED.",
  },
];

/** The validated briefs, keyed by id. Validated at import: a bad brief, or a
 * set that is not exactly SPECIALIST_BRIEF_IDS, is a startup error. */
export const SPECIALIST_BRIEFS: ReadonlyMap<SpecialistBriefId, SpecialistBrief> = new Map(
  RAW_BRIEFS.map((brief) => {
    const checked = validateSpecialistBrief(brief);
    return [checked.id, checked] as const;
  }),
);
if (SPECIALIST_BRIEFS.size !== SPECIALIST_BRIEF_IDS.length || !SPECIALIST_BRIEF_IDS.every((id) => SPECIALIST_BRIEFS.has(id))) {
  fail("invalid_brief", `specialist briefs must be exactly ${SPECIALIST_BRIEF_IDS.join(", ")}`);
}

export function listSpecialistBriefIds(): SpecialistBriefId[] {
  return [...SPECIALIST_BRIEF_IDS];
}

/** The brief for `id`. Unknown ids throw; there is no default brief. */
export function getSpecialistBrief(id: unknown): SpecialistBrief {
  const brief = typeof id === "string" ? SPECIALIST_BRIEFS.get(id as SpecialistBriefId) : undefined;
  if (!brief) return fail("unknown_brief", `unknown specialist brief ${JSON.stringify(id)}`);
  return brief;
}

// ── action check ──────────────────────────────────────────────────────

/** Throw unless every action is one the brief permits. Forbidden and unknown
 * actions are denied. */
export function assertReviewerActionsAllowed(id: unknown, actions: unknown): void {
  const brief = getSpecialistBrief(id);
  if (!Array.isArray(actions)) fail("action_denied", "actions must be an array");
  for (const action of actions as unknown[]) {
    if (typeof action !== "string") fail("action_denied", `action ${JSON.stringify(action)} is not an action id`);
    const name = action as string;
    if ((REVIEWER_FORBIDDEN_ACTIONS as readonly string[]).includes(name) || brief.forbiddenActions.includes(name)) {
      fail("action_denied", `action ${name} is forbidden for brief ${brief.id}`);
    }
    if (!(brief.permittedActions as readonly string[]).includes(name)) {
      fail("action_denied", `action ${name} is not permitted by brief ${brief.id}`);
    }
  }
}

// ── rendering ─────────────────────────────────────────────────────────

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join("\n");
const numbered = (items: readonly string[]): string => items.map((item, i) => `${i + 1}. ${item}`).join("\n");

function plainVars(vars: unknown): Map<string, string> {
  if (vars === undefined || vars === null) return new Map();
  if (typeof vars !== "object" || Array.isArray(vars)) fail("invalid_vars", "vars must be an object of strings");
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
    if (typeof value !== "string") fail("invalid_vars", `input ${name} must be a string`);
    const trimmed = (value as string).trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_VAR) fail("invalid_vars", `input ${name} exceeds ${MAX_VAR} characters`);
    if (/\{\{|\}\}/.test(trimmed)) fail("invalid_vars", `input ${name} may not contain placeholder braces`);
    out.set(name, trimmed);
  }
  return out;
}

/** Render a brief for a reviewer. Unknown, non-string, or brace-containing
 * variables throw, and so does a missing required input: without it the
 * review cannot run, so the caller records BLOCKED instead of dispatching. */
export function renderSpecialistBrief(id: unknown, vars: unknown = {}): string {
  const brief = getSpecialistBrief(id);
  const given = plainVars(vars);
  const declared = new Set(brief.inputs.map((input) => input.name));
  const unknown = [...given.keys()].filter((name) => !declared.has(name));
  if (unknown.length) fail("invalid_vars", `brief ${brief.id} has no inputs named ${unknown.join(", ")}`);
  const missing = brief.inputs.filter((input) => input.required && !given.has(input.name)).map((input) => input.name);
  if (missing.length) fail("invalid_vars", `brief ${brief.id} needs inputs ${missing.join(", ")}; without them the review is BLOCKED`);
  const sha = given.get("sha");
  if (sha !== undefined && !SHA_RE.test(sha)) fail("invalid_vars", `brief ${brief.id} input sha must be a full 40-hex SHA`);

  const fill = (value: string): string => value.replace(PLACEHOLDER_RE, (_, name: string) => given.get(name) ?? "(not provided)");
  const concluding = brief.outcomes.filter((outcome) => !(STOP_OUTCOMES as readonly string[]).includes(outcome));
  return [
    `# Specialist brief: ${brief.title} (${brief.id}, v${brief.version})`,
    "",
    "## Identity",
    "Role: reviewer (read-only)",
    `When to use: ${brief.whenToUse}`,
    `Objective: ${fill(brief.objective)}`,
    "",
    "## Inputs",
    bullets(brief.inputs.map((input) => `${input.name}${input.required ? " (required)" : ""}: ${given.get(input.name) ?? "(not provided)"}`)),
    "",
    "## Steps",
    numbered(brief.steps.map(fill)),
    "",
    "## Permitted tools",
    bullets(brief.permittedTools),
    "",
    "## Required evidence",
    bullets(brief.requiredEvidence.map((item) => `${item.key}: ${fill(item.description)}`)),
    "",
    "## Report",
    `${brief.expectedArtifact.kind}: ${fill(brief.expectedArtifact.description)}`,
    `Outcome: one of ${brief.outcomes.join(", ")}. ${concluding.join(" or ")} needs every required evidence item; otherwise report BLOCKED or NOT RUN and list what is missing.`,
    "Sections, in order:",
    numbered(brief.reportSections),
    "",
    "## Uncertainty, missing inputs, and NOT RUN",
    bullets([...SHARED_UNCERTAINTY_RULES, ...brief.uncertaintyRules.map(fill)]),
    "",
    "## Stop conditions",
    bullets(brief.stopConditions.map(fill)),
    "",
    "## Done when",
    fill(brief.completionCondition),
    "",
    "## Permitted actions",
    bullets(brief.permittedActions),
    "",
    "## Forbidden actions",
    bullets(brief.forbiddenActions),
    "",
    "## Guardrails",
    REVIEWER_GUARDRAILS,
    "",
  ].join("\n");
}

// ── report check ──────────────────────────────────────────────────────

export interface ReportClaim {
  statement: string;
  label: ClaimLabel;
  /** Required when label is verified. */
  evidence?: string;
}

export interface SpecialistReport {
  briefId: SpecialistBriefId;
  outcome: string;
  /** requiredEvidence key → citation. */
  evidence: Readonly<Record<string, string>>;
  claims: readonly ReportClaim[];
  /** What is missing, or why the review did not run. Required for BLOCKED and NOT RUN. */
  missing: readonly string[];
  /** Checks not run. A concluding report may list some; they stay NOT RUN. */
  notRun: readonly string[];
}

const REPORT_KEYS = ["briefId", "outcome", "evidence", "claims", "missing", "notRun"];

function reportList(where: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid_report", `${where} must be a list`);
  return (value as unknown[]).map((item, index) => {
    if (typeof item !== "string" || !item.trim()) fail("invalid_report", `${where}[${index}] must be a non-empty string`);
    return (item as string).trim();
  });
}

/** Check a reviewer's report and return a frozen copy. Throws when the
 * outcome is not one the brief offers (so no pass, approval, or clearance),
 * a field or evidence key is unknown, a verified claim cites nothing, a
 * concluding outcome lacks any required evidence (or a reviewedSha without a
 * full SHA), or BLOCKED / NOT RUN does not say what is missing. */
export function checkSpecialistReport(raw: unknown): SpecialistReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_report", "report must be an object");
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).filter((key) => !REPORT_KEYS.includes(key));
  if (extra.length) fail("invalid_report", `report has unsupported fields: ${extra.join(", ")}`);
  const brief = getSpecialistBrief(obj.briefId);
  const where = `report for ${brief.id}:`;

  if (typeof obj.outcome !== "string" || !brief.outcomes.includes(obj.outcome)) {
    fail("invalid_report", `${where} outcome ${JSON.stringify(obj.outcome)} is not one of ${brief.outcomes.join(", ")}`);
  }
  const outcome = obj.outcome as string;

  const evidenceRaw = obj.evidence ?? {};
  if (typeof evidenceRaw !== "object" || Array.isArray(evidenceRaw)) fail("invalid_report", `${where} evidence must be an object`);
  const keys = new Set(brief.requiredEvidence.map((item) => item.key));
  const evidence: Record<string, string> = {};
  for (const [key, value] of Object.entries(evidenceRaw as Record<string, unknown>)) {
    if (!keys.has(key)) fail("invalid_report", `${where} evidence key ${key} is not one of ${[...keys].join(", ")}`);
    if (typeof value !== "string") fail("invalid_report", `${where} evidence ${key} must be a string`);
    evidence[key] = (value as string).trim();
  }

  if (obj.claims !== undefined && !Array.isArray(obj.claims)) fail("invalid_report", `${where} claims must be a list`);
  const claims = ((obj.claims ?? []) as unknown[]).map((item, index): ReportClaim => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("invalid_report", `${where} claims[${index}] must be an object`);
    const claim = item as Record<string, unknown>;
    const extraClaimKeys = Object.keys(claim).filter((key) => !["statement", "label", "evidence"].includes(key));
    if (extraClaimKeys.length) fail("invalid_report", `${where} claims[${index}] has unsupported fields: ${extraClaimKeys.join(", ")}`);
    if (typeof claim.statement !== "string" || !claim.statement.trim()) fail("invalid_report", `${where} claims[${index}].statement is empty`);
    if (!(CLAIM_LABELS as readonly unknown[]).includes(claim.label)) {
      fail("invalid_report", `${where} claims[${index}].label must be one of ${CLAIM_LABELS.join(", ")}`);
    }
    if (claim.evidence !== undefined && typeof claim.evidence !== "string") fail("invalid_report", `${where} claims[${index}].evidence must be a string`);
    if (claim.label === "verified" && !isEvidence(claim.evidence)) {
      fail("evidence_missing", `${where} claims[${index}] is labelled verified but cites no evidence; label it inferred or unknown`);
    }
    return {
      statement: (claim.statement as string).trim(),
      label: claim.label as ClaimLabel,
      ...(claim.evidence === undefined ? {} : { evidence: (claim.evidence as string).trim() }),
    };
  });

  const missing = reportList(`${where} missing`, obj.missing);
  const notRun = reportList(`${where} notRun`, obj.notRun);

  if ((STOP_OUTCOMES as readonly string[]).includes(outcome)) {
    if (!missing.length) fail("invalid_report", `${where} ${outcome} must list what is missing or why it did not run`);
  } else {
    const absent = brief.requiredEvidence.filter((item) => !isEvidence(evidence[item.key])).map((item) => item.key);
    if (absent.length) {
      fail("evidence_missing", `${where} ${outcome} needs evidence for ${absent.join(", ")}; report BLOCKED with them listed instead`);
    }
    if (keys.has("reviewedSha") && !SHA_IN_TEXT_RE.test(evidence.reviewedSha)) {
      fail("evidence_missing", `${where} reviewedSha must cite the full 40-hex SHA reviewed`);
    }
  }

  return deepFreeze({ briefId: brief.id, outcome, evidence, claims, missing, notRun });
}
