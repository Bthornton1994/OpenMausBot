// Factory specialist briefs — the five read-only reviewer briefs are complete,
// stay inside the reviewer ceiling, demand their inputs, and fail closed when
// a report concludes without its evidence. Fixtures are synthetic; no brief
// is run against a real product.
import { describe, expect, it } from "vitest";

import {
  assertReviewerActionsAllowed,
  checkSpecialistReport,
  getSpecialistBrief,
  listSpecialistBriefIds,
  renderSpecialistBrief,
  REVIEWER_ACTIONS,
  REVIEWER_FORBIDDEN_ACTIONS,
  REVIEWER_GUARDRAILS,
  SPECIALIST_BRIEF_IDS,
  SPECIALIST_BRIEFS,
  SpecialistBriefError,
  validateSpecialistBrief,
  type SpecialistBrief,
  type SpecialistBriefErrorCode,
  type SpecialistBriefId,
} from "./factory-specialist-briefs.ts";

const SHA = "a".repeat(40);

function expectCode(fn: () => unknown, code: SpecialistBriefErrorCode): SpecialistBriefError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SpecialistBriefError);
    expect((error as SpecialistBriefError).code).toBe(code);
    return error as SpecialistBriefError;
  }
  throw new Error(`expected SpecialistBriefError ${code}, nothing was thrown`);
}

/** A mutable copy of a built-in, for building bad variants. */
function copyOf(id: SpecialistBriefId): SpecialistBrief {
  return structuredClone(getSpecialistBrief(id)) as SpecialistBrief;
}

/** One small synthetic example per specialist: the vars a caller would pass
 * and a complete report the reviewer would return. */
const FIXTURES: Record<SpecialistBriefId, { vars: Record<string, string>; report: Record<string, unknown> }> = {
  "codebase-navigator": {
    vars: { question: "Where does the widget count get saved?", repo: "acme/widgets", sha: SHA },
    report: {
      briefId: "codebase-navigator",
      outcome: "MAPPED",
      evidence: {
        reviewedSha: SHA,
        entryPoints: "server/routes.ts:42 POST /widgets",
        flows: "server/routes.ts:42 → server/store.ts:88 saveWidget → server/db.ts:12",
        tests: "server/store.test.ts 'saves the count': pnpm exec vitest run server/store.test.ts PASS",
        docs: "docs/widgets.md",
      },
      claims: [
        { statement: "saveWidget writes the count", label: "verified", evidence: "server/store.ts:88" },
        { statement: "the cache layer also writes it", label: "inferred" },
      ],
      notRun: ["full suite"],
    },
  },
  "security-privacy-review": {
    vars: { surface: "server/upload.ts", repo: "acme/widgets", sha: SHA },
    report: {
      briefId: "security-privacy-review",
      outcome: "FINDINGS",
      evidence: {
        reviewedSha: SHA,
        surfacesReviewed: "server/upload.ts, server/paths.ts",
        checksRun: "path traversal: pnpm exec vitest run server/upload.test.ts -t traversal → FAIL (file written outside root)",
      },
      claims: [
        { statement: "upload name ../x escapes the root", label: "verified", evidence: "server/upload.ts:31; upload.test.ts traversal case fails" },
      ],
    },
  },
  "ui-accessibility-review": {
    vars: { surface: "Settings page", interfaceSource: "http://127.0.0.1:5173/settings (build aaaa…)" },
    report: {
      briefId: "ui-accessibility-review",
      outcome: "NO_FINDINGS",
      evidence: {
        interfaceInspected: `http://127.0.0.1:5173/settings served from ${SHA}`,
        statesExercised: "default, empty, error; 360px and 1280px; light and dark",
        accessibilityChecks: "keyboard order PASS (tabbed through); focus ring PASS; contrast PASS (inspector); screen reader NOT RUN",
      },
      notRun: ["screen reader"],
    },
  },
  "game-interaction-review": {
    vars: {
      product: "Fixture Arena (synthetic)",
      build: "fixture build 0.0.1 at local preview",
      visionRef: "fixtures/vision.md v3",
      references: "fixtures/ref-dash.md",
      focus: "dash and cancel",
    },
    report: {
      briefId: "game-interaction-review",
      outcome: "FINDINGS",
      evidence: {
        buildInspected: "fixture build 0.0.1, launched with the local preview script",
        visionRef: "fixtures/vision.md v3",
        referencesRead: "fixtures/ref-dash.md",
        interactionsExercised: "dash: Shift+Right ×3 (capture-01); cancel: Shift then Esc within 100 ms (capture-02)",
      },
      claims: [
        { statement: "dash cannot be cancelled, unlike vision §2.1", label: "verified", evidence: "capture-02; fixtures/vision.md:14" },
        { statement: "should dash have coyote time?", label: "unknown" },
      ],
    },
  },
  "release-readiness-review": {
    vars: {
      repo: "acme/widgets",
      sha: SHA,
      ciSource: "https://ci.example/runs/1",
      qaRecord: "lane L-1",
      deployTarget: "preview",
      launchGates: "G1 (owner), G2 (owner)",
    },
    report: {
      briefId: "release-readiness-review",
      outcome: "RECONCILED",
      evidence: {
        reviewedSha: SHA,
        ciRun: `run 1 attempt 1 on ${SHA}: success`,
        qaDisposition: `PASS_KEEP_DRAFT by qa-bot on ${SHA}`,
        deploymentState: "preview serves an older SHA (read from the deploy dashboard)",
        launchGates: "G1 open, owner decides; G2 no decision recorded",
      },
    },
  },
};

describe("catalog", () => {
  it("is exactly the five reviewer briefs, each valid and frozen", () => {
    expect(listSpecialistBriefIds()).toEqual([
      "codebase-navigator",
      "security-privacy-review",
      "ui-accessibility-review",
      "game-interaction-review",
      "release-readiness-review",
    ]);
    expect([...SPECIALIST_BRIEFS.keys()]).toEqual([...SPECIALIST_BRIEF_IDS]);
    expect(Object.keys(FIXTURES).sort()).toEqual([...SPECIALIST_BRIEF_IDS].sort());
    for (const brief of SPECIALIST_BRIEFS.values()) {
      expect(validateSpecialistBrief(structuredClone(brief) as SpecialistBrief)).toEqual(brief);
      expect(Object.isFrozen(brief)).toBe(true);
      expect(Object.isFrozen(brief.permittedActions)).toBe(true);
    }
  });

  it("each brief defines when to use it, inputs, evidence, output, uncertainty rules, stops, and a completion condition", () => {
    for (const id of SPECIALIST_BRIEF_IDS) {
      const brief = getSpecialistBrief(id);
      expect(brief.whenToUse).not.toBe("");
      expect(brief.inputs.some((input) => input.required)).toBe(true);
      expect(brief.requiredEvidence.length).toBeGreaterThan(0);
      expect(brief.expectedArtifact.kind).not.toBe("");
      expect(brief.reportSections.length).toBeGreaterThan(0);
      expect(brief.outcomes).toEqual(expect.arrayContaining(["BLOCKED", "NOT RUN"]));
      expect(brief.uncertaintyRules.length).toBeGreaterThan(0);
      expect(brief.stopConditions.length).toBeGreaterThan(0);
      expect(brief.completionCondition).toMatch(/^Done when /);
    }
  });

  it.each(["implementer-brief", "independent-qa-brief", "completion-report", "production-readiness", "", 7, null])(
    "%j is not a specialist brief",
    (id) => {
      expectCode(() => getSpecialistBrief(id), "unknown_brief");
    },
  );

  it("rejects a brief set or brief outside the catalog", () => {
    expectCode(() => validateSpecialistBrief({ ...copyOf("codebase-navigator"), id: "qa-brief" as SpecialistBriefId }), "invalid_brief");
    expectCode(() => validateSpecialistBrief({ ...copyOf("codebase-navigator"), version: 2 as 1 }), "invalid_brief");
  });
});

describe("role permissions", () => {
  const prohibited = [
    "edit-files",
    "commit",
    "push-fork",
    "approve-pr",
    "merge",
    "undraft",
    "deploy",
    "set-product-flags",
    "clear-owner-gates",
    "clear-project-gates",
    "claim-production-readiness",
    "record-qa-disposition",
    "submit-qa-clearance",
    "give-legal-advice",
    "attest-for-owner",
  ];

  it("every brief is a read-only reviewer that forbids every write and sign-off", () => {
    for (const id of SPECIALIST_BRIEF_IDS) {
      const brief = getSpecialistBrief(id);
      expect(brief.role).toBe("reviewer");
      for (const action of brief.permittedActions) expect(REVIEWER_ACTIONS).toContain(action);
      for (const action of REVIEWER_FORBIDDEN_ACTIONS) expect(brief.forbiddenActions).toContain(action);
      for (const action of prohibited) {
        expect(REVIEWER_FORBIDDEN_ACTIONS).toContain(action);
        expectCode(() => assertReviewerActionsAllowed(id, [action]), "action_denied");
      }
    }
  });

  it("permits each brief only the reads it needs", () => {
    assertReviewerActionsAllowed("codebase-navigator", ["read-repo", "run-tests", "record-findings"]);
    assertReviewerActionsAllowed("ui-accessibility-review", ["inspect-ui", "record-findings"]);
    assertReviewerActionsAllowed("game-interaction-review", ["inspect-ui", "report-status"]);
    assertReviewerActionsAllowed("release-readiness-review", ["read-ci-status", "read-deploy-status"]);
    expectCode(() => assertReviewerActionsAllowed("codebase-navigator", ["read-deploy-status"]), "action_denied");
    expectCode(() => assertReviewerActionsAllowed("security-privacy-review", ["inspect-ui"]), "action_denied");
    expectCode(() => assertReviewerActionsAllowed("release-readiness-review", ["run-tests"]), "action_denied");
  });

  it("denies unknown actions and malformed action lists", () => {
    expectCode(() => assertReviewerActionsAllowed("codebase-navigator", ["read-everything"]), "action_denied");
    expectCode(() => assertReviewerActionsAllowed("codebase-navigator", [42]), "action_denied");
    expectCode(() => assertReviewerActionsAllowed("codebase-navigator", "read-repo"), "action_denied");
    expectCode(() => assertReviewerActionsAllowed("not-a-brief", ["read-repo"]), "unknown_brief");
  });

  it("rejects a brief that widens the ceiling, drops a forbidden action, or changes role", () => {
    const editing = copyOf("codebase-navigator");
    expectCode(() => validateSpecialistBrief({ ...editing, permittedActions: [...editing.permittedActions, "edit-files" as never] }), "action_denied");
    const qa = copyOf("security-privacy-review");
    expectCode(() => validateSpecialistBrief({ ...qa, permittedActions: [...qa.permittedActions, "record-qa-disposition" as never] }), "action_denied");
    const dropped = copyOf("ui-accessibility-review");
    expectCode(() => validateSpecialistBrief({ ...dropped, forbiddenActions: dropped.forbiddenActions.filter((a) => a !== "approve-pr") }), "action_denied");
    expectCode(() => validateSpecialistBrief({ ...copyOf("game-interaction-review"), role: "qa" as "reviewer" }), "invalid_brief");
  });

  it.each(["PASS", "PASS_KEEP_DRAFT", "APPROVED", "CLEARED", "READY", "MERGE_OK", "LAUNCH", "DEPLOYABLE"])(
    "rejects a brief offering the %s outcome",
    (outcome) => {
      const brief = copyOf("release-readiness-review");
      expectCode(() => validateSpecialistBrief({ ...brief, outcomes: [outcome, ...brief.outcomes] }), "invalid_brief");
    },
  );

  it("rejects a brief without BLOCKED, NOT RUN, or a concluding outcome", () => {
    const brief = copyOf("ui-accessibility-review");
    expectCode(() => validateSpecialistBrief({ ...brief, outcomes: ["FINDINGS", "NOT RUN"] }), "invalid_brief");
    expectCode(() => validateSpecialistBrief({ ...brief, outcomes: ["FINDINGS", "BLOCKED"] }), "invalid_brief");
    expectCode(() => validateSpecialistBrief({ ...brief, outcomes: ["BLOCKED", "NOT RUN"] }), "invalid_brief");
  });
});

describe("required inputs and outputs", () => {
  const requiredInputs: Record<SpecialistBriefId, string[]> = {
    "codebase-navigator": ["question", "repo", "sha"],
    "security-privacy-review": ["surface", "repo", "sha"],
    "ui-accessibility-review": ["surface", "interfaceSource"],
    "game-interaction-review": ["product", "build", "visionRef", "references", "focus"],
    "release-readiness-review": ["repo", "sha", "ciSource", "qaRecord", "deployTarget", "launchGates"],
  };
  const requiredEvidence: Record<SpecialistBriefId, string[]> = {
    "codebase-navigator": ["reviewedSha", "entryPoints", "flows", "tests", "docs"],
    "security-privacy-review": ["reviewedSha", "surfacesReviewed", "checksRun"],
    "ui-accessibility-review": ["interfaceInspected", "statesExercised", "accessibilityChecks"],
    "game-interaction-review": ["buildInspected", "visionRef", "referencesRead", "interactionsExercised"],
    "release-readiness-review": ["reviewedSha", "ciRun", "qaDisposition", "deploymentState", "launchGates"],
  };

  it.each(SPECIALIST_BRIEF_IDS)("%s declares its required inputs and evidence", (id) => {
    const brief = getSpecialistBrief(id);
    expect(brief.inputs.filter((input) => input.required).map((input) => input.name)).toEqual(requiredInputs[id]);
    expect(brief.requiredEvidence.map((item) => item.key)).toEqual(requiredEvidence[id]);
  });

  it.each(SPECIALIST_BRIEF_IDS)("%s renders every section from its fixture", (id) => {
    const brief = getSpecialistBrief(id);
    const text = renderSpecialistBrief(id, FIXTURES[id].vars);
    for (const heading of [
      "## Identity",
      "## Inputs",
      "## Steps",
      "## Permitted tools",
      "## Required evidence",
      "## Report",
      "## Uncertainty, missing inputs, and NOT RUN",
      "## Stop conditions",
      "## Done when",
      "## Permitted actions",
      "## Forbidden actions",
      "## Guardrails",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Role: reviewer (read-only)");
    expect(text).toContain(`When to use: ${brief.whenToUse}`);
    for (const item of brief.requiredEvidence) expect(text).toContain(`- ${item.key}: `);
    expect(text).toContain(`Outcome: one of ${brief.outcomes.join(", ")}.`);
    for (const action of REVIEWER_FORBIDDEN_ACTIONS) expect(text).toContain(`- ${action}\n`);
    expect(text).toContain("A check you did not run is NOT RUN, never PASS.");
    expect(text.endsWith(`${REVIEWER_GUARDRAILS}\n`)).toBe(true);
    expect(text).not.toMatch(/\{\{/);
    for (const value of Object.values(FIXTURES[id].vars)) expect(text).toContain(value);
  });

  it.each(SPECIALIST_BRIEF_IDS)("%s refuses to render without each required input", (id) => {
    for (const name of requiredInputs[id]) {
      const vars = { ...FIXTURES[id].vars };
      delete vars[name];
      const error = expectCode(() => renderSpecialistBrief(id, vars), "invalid_vars");
      expect(error.message).toContain(name);
      expect(error.message).toContain("BLOCKED");
      expectCode(() => renderSpecialistBrief(id, { ...FIXTURES[id].vars, [name]: "   " }), "invalid_vars");
    }
  });

  it("refuses unknown, non-string, brace-containing, or malformed vars", () => {
    const vars = FIXTURES["codebase-navigator"].vars;
    expectCode(() => renderSpecialistBrief("codebase-navigator", { ...vars, approval: "yes" }), "invalid_vars");
    expectCode(() => renderSpecialistBrief("codebase-navigator", { ...vars, question: 1 }), "invalid_vars");
    expectCode(() => renderSpecialistBrief("codebase-navigator", { ...vars, question: "{{sha}}" }), "invalid_vars");
    expectCode(() => renderSpecialistBrief("codebase-navigator", { ...vars, sha: "abc123" }), "invalid_vars");
    expectCode(() => renderSpecialistBrief("codebase-navigator", [vars]), "invalid_vars");
    expectCode(() => renderSpecialistBrief("implementer-brief", vars), "unknown_brief");
  });

  it("rejects a brief that uses an undeclared placeholder", () => {
    const brief = copyOf("codebase-navigator");
    expectCode(() => validateSpecialistBrief({ ...brief, completionCondition: "Done when {{owner}} says so." }), "invalid_brief");
  });
});

describe("fail-closed handling of missing evidence", () => {
  it.each(SPECIALIST_BRIEF_IDS)("%s accepts its complete fixture report", (id) => {
    const report = checkSpecialistReport(FIXTURES[id].report);
    expect(report.briefId).toBe(id);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it.each(SPECIALIST_BRIEF_IDS)("%s refuses a concluding outcome when any required evidence is missing or a placeholder", (id) => {
    const fixture = FIXTURES[id].report;
    for (const item of getSpecialistBrief(id).requiredEvidence) {
      const evidence = { ...(fixture.evidence as Record<string, string>) };
      delete evidence[item.key];
      expectCode(() => checkSpecialistReport({ ...fixture, evidence }), "evidence_missing");
      for (const placeholder of ["", "NOT RUN", "pass", "unknown", "TBD", "n/a"]) {
        expectCode(() => checkSpecialistReport({ ...fixture, evidence: { ...evidence, [item.key]: placeholder } }), "evidence_missing");
      }
    }
  });

  it.each(SPECIALIST_BRIEF_IDS)("%s accepts BLOCKED with nothing inspected only when it names what is missing", (id) => {
    expect(checkSpecialistReport({ briefId: id, outcome: "BLOCKED", missing: ["required input not supplied"] }).outcome).toBe("BLOCKED");
    expect(checkSpecialistReport({ briefId: id, outcome: "NOT RUN", missing: ["stopped: the SHA moved"] }).outcome).toBe("NOT RUN");
    expectCode(() => checkSpecialistReport({ briefId: id, outcome: "BLOCKED" }), "invalid_report");
    expectCode(() => checkSpecialistReport({ briefId: id, outcome: "NOT RUN", missing: [] }), "invalid_report");
  });

  it("keeps evidence apart from guesses: a verified claim must cite evidence", () => {
    const fixture = FIXTURES["codebase-navigator"].report;
    expectCode(
      () => checkSpecialistReport({ ...fixture, claims: [{ statement: "the cache writes it", label: "verified" }] }),
      "evidence_missing",
    );
    expectCode(
      () => checkSpecialistReport({ ...fixture, claims: [{ statement: "the cache writes it", label: "verified", evidence: "unknown" }] }),
      "evidence_missing",
    );
    expectCode(() => checkSpecialistReport({ ...fixture, claims: [{ statement: "x", label: "likely" }] }), "invalid_report");
  });

  it("requires the exact reviewed SHA where the brief reviews a commit", () => {
    const fixture = FIXTURES["security-privacy-review"].report;
    const evidence = { ...(fixture.evidence as Record<string, string>), reviewedSha: "main, latest" };
    expectCode(() => checkSpecialistReport({ ...fixture, evidence }), "evidence_missing");
  });

  it("UI review without an inspected interface is BLOCKED, never a visual pass", () => {
    const fixture = FIXTURES["ui-accessibility-review"].report;
    const evidence = { ...(fixture.evidence as Record<string, string>) };
    delete evidence.interfaceInspected;
    expectCode(() => checkSpecialistReport({ ...fixture, evidence }), "evidence_missing");
    expectCode(() => checkSpecialistReport({ ...fixture, outcome: "PASS" }), "invalid_report");
    expect(
      checkSpecialistReport({ briefId: "ui-accessibility-review", outcome: "BLOCKED", missing: ["interfaceSource did not load"] }).outcome,
    ).toBe("BLOCKED");
  });

  it("game review without the vision, references, or a played build cannot conclude", () => {
    const fixture = FIXTURES["game-interaction-review"].report;
    for (const key of ["visionRef", "referencesRead", "buildInspected", "interactionsExercised"]) {
      const evidence = { ...(fixture.evidence as Record<string, string>) };
      delete evidence[key];
      expectCode(() => checkSpecialistReport({ ...fixture, outcome: "NO_FINDINGS", evidence, claims: [] }), "evidence_missing");
    }
  });

  it("release readiness reports only: no pass, merge, or launch outcome and no smuggled clearance field", () => {
    const fixture = FIXTURES["release-readiness-review"].report;
    for (const outcome of ["PASS", "PASS_KEEP_DRAFT", "MERGE_READY", "LAUNCH_CLEARED", "APPROVED", "QA_CLEAR"]) {
      expectCode(() => checkSpecialistReport({ ...fixture, outcome }), "invalid_report");
    }
    expectCode(() => checkSpecialistReport({ ...fixture, mergeClearance: true }), "invalid_report");
    expectCode(
      () => checkSpecialistReport({ ...fixture, evidence: { ...(fixture.evidence as Record<string, string>), launchClearance: "yes" } }),
      "invalid_report",
    );
    const evidence = { ...(fixture.evidence as Record<string, string>) };
    delete evidence.qaDisposition;
    expectCode(() => checkSpecialistReport({ ...fixture, evidence }), "evidence_missing");
    expect(checkSpecialistReport(fixture).evidence.qaDisposition).toBe(`PASS_KEEP_DRAFT by qa-bot on ${SHA}`);
  });

  it("rejects malformed reports and unknown briefs", () => {
    expectCode(() => checkSpecialistReport(null), "invalid_report");
    expectCode(() => checkSpecialistReport([]), "invalid_report");
    expectCode(() => checkSpecialistReport({ briefId: "independent-qa-brief", outcome: "BLOCKED", missing: ["x"] }), "unknown_brief");
    const fixture = FIXTURES["codebase-navigator"].report;
    expectCode(() => checkSpecialistReport({ ...fixture, evidence: [] }), "invalid_report");
    expectCode(() => checkSpecialistReport({ ...fixture, notRun: "all" }), "invalid_report");
    expectCode(() => checkSpecialistReport({ ...fixture, claims: [{ statement: "x", label: "verified", evidence: "a:1", approved: true }] }), "invalid_report");
  });
});
