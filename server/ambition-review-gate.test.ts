import { describe, expect, it } from "vitest";
import {
  isReadOnlyDuringAmbitionReview,
  precedingCoSAssistantText,
  requiresAmbitionReview,
  selectedAmbitionReviewOption,
  shouldBlockAmbitionReviewAction,
  transitionAmbitionReview,
} from "./ambition-review-gate.ts";

describe("ambition review selection gate", () => {
  it.each([
    "Run an ambition-review before implementing this project.",
    "Plan and implement a multi-step migration, then verify it.",
    "Plan a long-term strategy for the team workflow.",
    "We have an ambiguous project decision: should we split the architecture?",
    "How should we architect this project?",
    "Which architecture should we use for this product?",
    "How should we approach this multi-step project?",
    "What's the right architecture for this project?",
    "Should we split the app into services?",
    "Should we use a monorepo for this project?",
    "Build the CSV export.",
    "Build and independently verify the CSV export.",
    "Automate the daily repository release checklist.",
    "Improve the product onboarding flow.",
    "Fix the typo in this button label and redesign the entire workflow.",
    "Fix the typo in this button label. Separately, plan a broader project migration.",
    "Fix the typo in this button label while redesigning the broader workflow.",
    "Fix the typo in this button label, redesign the broader workflow.",
    "Fix the typo in this button label, but should we use a different architecture?",
  ])("recognizes project-scale or multi-step work: %s", (text) => {
    expect(requiresAmbitionReview(text)).toBe(true);
  });

  it.each([
    "Fix the typo in this button label.",
    "Update the wording in README.md.",
    "What strategy should I use to rename this icon?",
    "What is the current version?",
  ])("does not gate a clear narrow fix or simple question: %s", (text) => {
    expect(requiresAmbitionReview(text)).toBe(false);
  });

  it.each([
    ["Depth", "Depth"],
    ["I choose option 2", "Depth"],
    ["Let's do Range", "Range"],
    ["Go with the first option", "Altitude"],
    ["I want the Depth option", "Depth"],
  ] as const)("recognizes an explicit user selection: %s", (text, option) => {
    expect(selectedAmbitionReviewOption(text)).toBe(option);
  });

  it.each([
    "I want Depth as one possibility, but compare it with Range.",
    "I might choose Depth.",
    "I don't choose Depth.",
    "Choose Depth or Range.",
  ])("does not treat an ambiguous or qualified reply as a selection: %s", (text) => {
    expect(selectedAmbitionReviewOption(text)).toBeNull();
  });

  it("accepts a short confirmation only when the prior CoS answer recommended one option", () => {
    expect(selectedAmbitionReviewOption("Let's do that", "I recommend Depth for this project."))
      .toBe("Depth");
    expect(selectedAmbitionReviewOption("Let's do that", "Here are three options: Altitude, Depth, and Range."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend considering Depth or Range."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend maybe Depth."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I don't recommend Depth for this project."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I don’t recommend Depth for this project."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend against Depth for this project."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend avoiding Depth."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend Depth. I recommend avoiding Depth."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend Depth. But Range is better."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes, but not Depth.", "I recommend Depth for this project."))
      .toBeNull();
    expect(selectedAmbitionReviewOption("Yes", "I recommend Depth. Actually, Range is the better fit."))
      .toBe("Range");
  });

  it("uses only the latest CoS reply as context for a short human confirmation", () => {
    const cos = { id: "cos", role: "bot", kind: "text", text: "I recommend Depth.", from: { botId: "chief" } };
    const peer = { id: "peer", role: "bot", kind: "text", text: "I recommend Altitude.", from: { botId: "peer" } };
    const current = { id: "user", role: "user", kind: "text", text: "Yes" };
    expect(precedingCoSAssistantText([cos, current], "user", "chief", true)).toBe("I recommend Depth.");
    expect(precedingCoSAssistantText([cos, peer, current], "user", "chief", true)).toBeUndefined();
    expect(precedingCoSAssistantText([
      { id: "direct", role: "bot", kind: "text", text: "I recommend Range." },
      current,
    ], "user", "chief", false)).toBe("I recommend Range.");
  });

  it("does not reuse a recommendation from before the current pending review", () => {
    const messages = [
      { id: "old-cos", role: "bot", kind: "text", text: "I recommend Depth.", from: { botId: "chief" } },
      { id: "new-review", role: "user", kind: "text", text: "Review this project." },
      { id: "current", role: "user", kind: "text", text: "Yes" },
    ];
    const preceding = precedingCoSAssistantText(messages, "current", "chief", false, "new-review");
    expect(preceding).toBeUndefined();
    expect(transitionAmbitionReview({ pending: true, chiefOfStaff: true, humanTurn: true,
      text: "Yes", precedingAssistantText: preceding })).toEqual({ pending: true });
  });

  it("persists through non-human work and clears only on a human selection", () => {
    expect(transitionAmbitionReview({ pending: false, chiefOfStaff: true, humanTurn: true,
      text: "Implement and verify this project-wide workflow." })).toEqual({ pending: true });
    expect(transitionAmbitionReview({ pending: true, chiefOfStaff: true, humanTurn: false,
      text: "A peer asked for help." })).toEqual({ pending: true });
    expect(transitionAmbitionReview({ pending: true, chiefOfStaff: true, humanTurn: true,
      text: "Fix the typo in this button label." })).toEqual({ pending: true });
    expect(transitionAmbitionReview({ pending: true, chiefOfStaff: true, humanTurn: true,
      text: "Depth" })).toEqual({ pending: false, selected: "Depth" });
  });

  it("allows only the reviewed GET routes while pending and fails closed for writes or unknown routes", () => {
    const reads = [
      "/api/internal/agents",
      "/api/internal/computer/select",
      "/api/internal/room-targets",
      "/api/internal/rooms",
      "/api/internal/routines",
      "/api/internal/shared-computers",
      "/api/internal/skills",
      "/api/internal/team-setup-catalog",
      "/api/internal/threads",
      "/api/internal/tool-result",
      "/api/internal/delegations/task-1234",
    ];
    for (const path of reads) expect(isReadOnlyDuringAmbitionReview("GET", path), path).toBe(true);
    for (const path of reads) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
        expect(isReadOnlyDuringAmbitionReview(method, path), `${method} ${path}`).toBe(false);
      }
    }
    for (const [method, path] of [
      ["POST", "/api/internal/coordinate-bots"],
      ["POST", "/api/internal/ask-bot"],
      ["POST", "/api/internal/delegate-bot"],
      ["POST", "/api/internal/threads"],
      ["POST", "/api/internal/retry-thread"],
      ["POST", "/api/internal/create-bot"],
      ["POST", "/api/internal/create-room"],
      ["POST", "/api/internal/vm-exec"],
      ["GET", "/api/internal/session-read"],
      ["GET", "/api/internal/session-search"],
      ["GET", "/api/internal/new-route"],
      ["GET", "/api/internal/rooms/room-123/delete"],
      ["GET", "/api/internal/agents/"],
      ["GET", "/api/internal/delegations/x"],
    ]) {
      expect(isReadOnlyDuringAmbitionReview(method!, path!), `${method} ${path}`).toBe(false);
    }
  });

  it("blocks unapproved internal capabilities while the hold is pending", () => {
    expect(shouldBlockAmbitionReviewAction({ pending: true, capabilityKind: "agents", method: "POST", path: "/api/internal/coordinate-bots" })).toBe(true);
    expect(shouldBlockAmbitionReviewAction({ pending: true, capabilityKind: "agents", method: "GET", path: "/api/internal/agents" })).toBe(false);
    expect(shouldBlockAmbitionReviewAction({ pending: false, capabilityKind: "agents", method: "POST", path: "/api/internal/coordinate-bots" })).toBe(false);
    for (const capabilityKind of ["connectors", "computer", "browser", "phone", "hooks"]) {
      expect(shouldBlockAmbitionReviewAction({ pending: true, capabilityKind, method: "POST", path: "/api/internal/action" }))
        .toBe(true);
    }
  });
});
