import { describe, expect, it } from "vitest";

import {
  ADVISOR_PROFILE_ID,
  assertMayPerform,
  assertMaySubmitQaClearance,
  buildSoftwareFactoryPackage,
  BUILT_IN_SPECIALIST_PROFILES,
  getSpecialistProfile,
  HARD_FORBIDDEN_ACTIONS,
  isReadOnlyProfile,
  listFactoryTeamProfiles,
  listSpecialistProfiles,
  ORCHESTRATOR_PROFILE_ID,
  permissionMatrix,
  PERMITTABLE_ACTIONS,
  SPECIALIST_PROFILE_IDS,
  SpecialistProfileError,
} from "./factory-specialist-profiles.ts";

describe("factory-specialist-profiles catalog", () => {
  it("exposes exactly eight specialists plus CoS and advisor", () => {
    expect(SPECIALIST_PROFILE_IDS).toHaveLength(8);
    expect(listSpecialistProfiles()).toHaveLength(8);
    expect(listFactoryTeamProfiles()).toHaveLength(10);
    expect(BUILT_IN_SPECIALIST_PROFILES.has(ORCHESTRATOR_PROFILE_ID)).toBe(true);
    expect(BUILT_IN_SPECIALIST_PROFILES.has(ADVISOR_PROFILE_ID)).toBe(true);
  });

  it("marks independent QA, security, production readiness, and advisor as read-only", () => {
    expect(isReadOnlyProfile("independent-qa")).toBe(true);
    expect(isReadOnlyProfile("security-privacy")).toBe(true);
    expect(isReadOnlyProfile("production-readiness")).toBe(true);
    expect(isReadOnlyProfile(ADVISOR_PROFILE_ID)).toBe(true);
    expect(isReadOnlyProfile("implementation")).toBe(false);
    expect(isReadOnlyProfile("test-engineering")).toBe(false);
  });

  it("gives every profile the full hard-forbidden set including submit-qa-clearance", () => {
    for (const profile of listFactoryTeamProfiles()) {
      for (const action of HARD_FORBIDDEN_ACTIONS) {
        expect(profile.forbiddenActions).toContain(action);
      }
      expect(profile.forbiddenActions).toContain("submit-qa-clearance");
      expect(profile.enforcement.roleText).toBe("prompt-only");
      expect(profile.enforcement.actionCeiling).toBe("code");
      expect(profile.enforcement.qaClearance).toBe("code");
    }
  });

  it("unknown profile ids fail closed", () => {
    expect(() => getSpecialistProfile("eligibility-check")).toThrow(SpecialistProfileError);
    try {
      getSpecialistProfile("not-a-role");
    } catch (error) {
      expect(error).toMatchObject({ code: "unknown_profile" });
    }
  });
});

describe("enforceable role boundaries", () => {
  it("allows implementation to edit files and denies QA the same action", () => {
    expect(() => assertMayPerform("implementation", "edit-files")).not.toThrow();
    expect(() => assertMayPerform("independent-qa", "edit-files")).toThrow(SpecialistProfileError);
    try {
      assertMayPerform("independent-qa", "edit-files");
    } catch (error) {
      expect(error).toMatchObject({ code: "action_denied" });
    }
  });

  it("allows test-engineering to edit tests but not product edit-files", () => {
    expect(() => assertMayPerform("test-engineering", "edit-tests")).not.toThrow();
    expect(() => assertMayPerform("test-engineering", "edit-files")).toThrow(SpecialistProfileError);
  });

  it("allows spec writers to write-spec and denies read-only roles", () => {
    expect(() => assertMayPerform("product-requirements", "write-spec")).not.toThrow();
    expect(() => assertMayPerform("architecture", "write-spec")).not.toThrow();
    expect(() => assertMayPerform("ux-accessibility", "write-spec")).not.toThrow();
    expect(() => assertMayPerform("independent-qa", "write-spec")).toThrow(SpecialistProfileError);
    expect(() => assertMayPerform("security-privacy", "write-spec")).toThrow(SpecialistProfileError);
    expect(() => assertMayPerform("production-readiness", "write-spec")).toThrow(SpecialistProfileError);
  });

  it("denies every hard-forbidden action for every profile", () => {
    for (const profile of listFactoryTeamProfiles()) {
      for (const action of HARD_FORBIDDEN_ACTIONS) {
        expect(() => assertMayPerform(profile.id, action)).toThrow(SpecialistProfileError);
      }
    }
  });

  it("denies unknown actions", () => {
    try {
      assertMayPerform("implementation", "teleport");
    } catch (error) {
      expect(error).toMatchObject({ code: "action_denied" });
    }
  });

  it("advisor may advise but never edit, commit, or push", () => {
    expect(() => assertMayPerform(ADVISOR_PROFILE_ID, "advise")).not.toThrow();
    for (const action of ["edit-files", "edit-tests", "write-spec", "commit", "push-fork"] as const) {
      expect(() => assertMayPerform(ADVISOR_PROFILE_ID, action)).toThrow(SpecialistProfileError);
    }
  });

  it("CoS may orchestrate/delegate but not edit product files", () => {
    expect(() => assertMayPerform(ORCHESTRATOR_PROFILE_ID, "orchestrate")).not.toThrow();
    expect(() => assertMayPerform(ORCHESTRATOR_PROFILE_ID, "delegate")).not.toThrow();
    expect(() => assertMayPerform(ORCHESTRATOR_PROFILE_ID, "edit-files")).toThrow(SpecialistProfileError);
  });
});

describe("F-6 QA clearance is code-enforced and denied", () => {
  it("refuses QA clearance for independent-qa without identity+permission proof", () => {
    try {
      assertMaySubmitQaClearance("independent-qa");
    } catch (error) {
      expect(error).toMatchObject({ code: "qa_clearance_denied" });
      expect(String(error)).toMatch(/F-6/);
    }
  });

  it("refuses QA clearance even when a caller claims identity fields (no binding on tip)", () => {
    try {
      assertMaySubmitQaClearance("independent-qa", {
        authenticatedBotId: "0b0f71eb-9bd3-4910-b09e-79a597d435e3",
        permissionBound: true,
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "qa_clearance_denied" });
      expect(String(error)).toMatch(/no code-enforced identity/);
    }
  });

  it("refuses QA clearance for writers and orchestrator alike", () => {
    for (const id of ["implementation", "product-requirements", ORCHESTRATOR_PROFILE_ID, ADVISOR_PROFILE_ID]) {
      expect(() => assertMaySubmitQaClearance(id)).toThrow(SpecialistProfileError);
    }
  });

  it("permission matrix documents prompt-only role text vs code ceilings", () => {
    const matrix = permissionMatrix();
    expect(matrix).toHaveLength(10);
    for (const row of matrix) {
      expect(row.roleTextEnforcement).toBe("prompt-only");
      expect(row.actionCeilingEnforcement).toBe("code");
      expect(row.qaClearanceEnforcement).toBe("code");
      expect(row.hardForbiddenCount).toBe(HARD_FORBIDDEN_ACTIONS.length);
      expect(row.approval).toBe("ask");
    }
    const qa = matrix.find((row) => row.id === "independent-qa");
    expect(qa?.writeClass).toBe("read-only");
    expect(qa?.permittedActions).not.toContain("edit-files");
  });
});

describe("OpenMaus package schema reuse", () => {
  it("buildSoftwareFactoryPackage validates against package-format", () => {
    const document = buildSoftwareFactoryPackage();
    expect(document.format).toBe("openmaus.package");
    expect(document.version).toBe(2);
    expect(document.package.id).toBe("software-factory-specialists");
    expect(document.package.team?.leader).toBe("chief-of-staff");
    expect(document.package.agents).toHaveLength(10);
    const keys = document.package.agents.map((agent) => agent.key).sort();
    expect(keys).toEqual(
      [
        "advisor",
        "architecture",
        "chief-of-staff",
        "implementation",
        "independent-qa",
        "product-requirements",
        "production-readiness",
        "security-privacy",
        "test-engineering",
        "ux-accessibility",
      ].sort(),
    );
    for (const agent of document.package.agents) {
      expect(agent.approval).toBe("ask");
      expect(agent.soul).toMatch(/F-6/);
    }
  });

  it("does not invent unsupported package fields on agents", () => {
    const document = buildSoftwareFactoryPackage();
    for (const agent of document.package.agents) {
      const keys = Object.keys(agent).sort();
      for (const key of keys) {
        expect([
          "key",
          "name",
          "title",
          "description",
          "soul",
          "appearance",
          "approval",
          "playbooks",
          "skills",
          "connections",
          "seed",
        ]).toContain(key);
      }
      expect(keys).not.toContain("model");
      expect(keys).not.toContain("permittedActions");
      expect(keys).not.toContain("writeClass");
    }
  });

  it("keeps permittable and hard-forbidden sets disjoint", () => {
    for (const action of HARD_FORBIDDEN_ACTIONS) {
      expect(PERMITTABLE_ACTIONS).not.toContain(action);
    }
  });
});
