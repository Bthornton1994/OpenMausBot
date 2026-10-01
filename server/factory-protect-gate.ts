// Factory protect gate — the CoS protect/eligibility source of truth, read
// from disk and applied to factory-lane writer claims.
//
// The CoS box keeps two files in its protect directory:
//   PROTECTED_SESSIONS.json — sessions nobody may re-seat or write into
//   FROZEN_TIPS.json        — repo+branch tips frozen for CI/QA/IR review
// harvest-dispatch.mjs on the box consults them through eligibility.mjs
// decide(). This module ports that decision to TypeScript so the in-repo lane
// store enforces the same SoT when it is configured.
//
// Configuration, first match wins:
//   1. an explicit `protectDir` option
//   2. env COS_FACTORY_PROTECT_DIR
//   3. env COS_FACTORY_ROOT + "/protect"
// None set → the gate is off and only the QA-role rules apply (the lane store
// keeps its ownership-only behaviour). Set but missing, unreadable, or invalid
// → every writer claim is DENIED. An unreadable protect list is never read as
// "nothing is protected".

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

export const PROTECTED_SESSIONS_FILE = "PROTECTED_SESSIONS.json";
export const FROZEN_TIPS_FILE = "FROZEN_TIPS.json";

const FULL_SHA = /^[0-9a-f]{40}$/i;

export interface ProtectedSession {
  sessionId: string;
  repo?: string;
  branch?: string;
  worktreePath?: string;
  reason?: string;
}

export interface FrozenTip {
  repo: string;
  branch: string;
  tipSha: string;
  worktreePath?: string;
  reason?: string;
}

export interface ProtectSoT {
  dir: string;
  sessions: ProtectedSession[];
  frozenTips: FrozenTip[];
}

export type ProtectLoadResult = { ok: true; sot: ProtectSoT } | { ok: false; dir: string; reason: string };

/** Which dispatch path is asking. `claim` covers claimWorktree and
 * claimNextEligible — the implementer claim APIs. `transition` is an owner
 * moving their own lane back to running (e.g. rework after QA FAIL). */
export type ProtectGateVia = "claim" | "transition";

export interface ProtectCandidate {
  laneId: string;
  role?: "implementer" | "qa";
  phase: string;
  repo: string;
  branch: string;
  worktreePath: string;
  /** The session the claim would write into (lane.agentSession). */
  writerTarget?: string;
  fullSha?: string;
}

export type ProtectRule = "config" | "qa_role" | "qa_phase" | "frozen_tip" | "protected_session" | "allow";

export interface ProtectDecision {
  decision: "ALLOW" | "DENY";
  rule: ProtectRule;
  reason: string;
  /** The protect directory consulted, when the gate is configured. */
  dir?: string;
}

/** The configured protect directory, or null when the gate is off. Empty
 * strings count as unset, the way a shell `VAR=` does. */
export function resolveProtectDir(protectDir?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (protectDir?.trim()) return protectDir.trim();
  const direct = env.COS_FACTORY_PROTECT_DIR?.trim();
  if (direct) return direct;
  const root = env.COS_FACTORY_ROOT?.trim();
  if (root) return join(root, "protect");
  return null;
}

// ── parsing (fail-closed: any doubtful entry invalidates the file) ─────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pick(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = str(entry[key]);
    if (value) return value;
  }
  return undefined;
}

/** A bare array, or an object holding the list under one of `keys`. */
function listFrom(raw: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let body: string;
  try {
    body = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? `${file} is missing` : `${file} is unreadable (${code ?? String(error)})` };
  }
  try {
    // Strip a UTF-8 BOM: PowerShell's Set-Content/Out-File write one.
    return { ok: true, value: JSON.parse(body.replace(/^﻿/, "")) };
  } catch {
    return { ok: false, reason: `${file} is not valid JSON` };
  }
}

function parseSessions(raw: unknown, file: string): ProtectedSession[] | string {
  const list = listFrom(raw, ["sessions", "protected", "protectedSessions"]);
  if (!list) return `${file} has no sessions list`;
  const sessions: ProtectedSession[] = [];
  for (const [index, item] of list.entries()) {
    if (typeof item === "string" && item.trim()) {
      sessions.push({ sessionId: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") return `${file} entry ${index} is not a session`;
    const entry = item as Record<string, unknown>;
    const sessionId = pick(entry, ["sessionId", "id", "session", "writerTarget"]);
    if (!sessionId) return `${file} entry ${index} has no session id`;
    const session: ProtectedSession = { sessionId };
    const repo = pick(entry, ["repo"]);
    const branch = pick(entry, ["branch"]);
    const worktreePath = pick(entry, ["worktreePath", "worktree", "cwd"]);
    const reason = pick(entry, ["reason", "note"]);
    if (repo) session.repo = repo;
    if (branch) session.branch = branch;
    if (worktreePath) session.worktreePath = worktreePath;
    if (reason) session.reason = reason;
    sessions.push(session);
  }
  return sessions;
}

function parseTips(raw: unknown, file: string): FrozenTip[] | string {
  const list = listFrom(raw, ["tips", "frozen", "frozenTips"]);
  if (!list) return `${file} has no tips list`;
  const tips: FrozenTip[] = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object") return `${file} entry ${index} is not a tip`;
    const entry = item as Record<string, unknown>;
    const repo = pick(entry, ["repo"]);
    const branch = pick(entry, ["branch"]);
    const tipSha = pick(entry, ["tipSha", "sha", "fullSha"]);
    if (!repo || !branch) return `${file} entry ${index} needs repo and branch`;
    if (!tipSha || !FULL_SHA.test(tipSha)) return `${file} entry ${index} needs a full 40-hex tipSha`;
    const tip: FrozenTip = { repo, branch, tipSha: tipSha.toLowerCase() };
    const worktreePath = pick(entry, ["worktreePath", "worktree", "cwd"]);
    const reason = pick(entry, ["reason", "note"]);
    if (worktreePath) tip.worktreePath = worktreePath;
    if (reason) tip.reason = reason;
    tips.push(tip);
  }
  return tips;
}

/** Read both SoT files from `dir`. Any failure is a reason, never an empty
 * list. Read fresh on every call: the CoS box edits these files live. */
export function loadProtectSoT(dir: string): ProtectLoadResult {
  const sessionsFile = join(dir, PROTECTED_SESSIONS_FILE);
  const tipsFile = join(dir, FROZEN_TIPS_FILE);
  const sessionsRaw = readJson(sessionsFile);
  if (!sessionsRaw.ok) return { ok: false, dir, reason: sessionsRaw.reason };
  const tipsRaw = readJson(tipsFile);
  if (!tipsRaw.ok) return { ok: false, dir, reason: tipsRaw.reason };
  const sessions = parseSessions(sessionsRaw.value, sessionsFile);
  if (typeof sessions === "string") return { ok: false, dir, reason: sessions };
  const frozenTips = parseTips(tipsRaw.value, tipsFile);
  if (typeof frozenTips === "string") return { ok: false, dir, reason: frozenTips };
  return { ok: true, sot: { dir, sessions, frozenTips } };
}

// ── decision ──────────────────────────────────────────────────────────

const norm = (value: string): string => value.trim().toLowerCase();

/** Same fail-closed folding as factory-lanes normalizeLanePath (kept local so
 * the lane store can import this module without a cycle). */
function normalizePath(path: string): string {
  const normalized = posix.normalize(path.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
  return (normalized || "/").toLowerCase();
}

function pathsNest(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (left === right) return true;
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter.endsWith("/") ? shorter : `${shorter}/`);
}

function sameRepoBranch(candidate: ProtectCandidate, target: { repo?: string; branch?: string }): boolean {
  return (
    target.repo !== undefined &&
    target.branch !== undefined &&
    norm(candidate.repo) === norm(target.repo) &&
    norm(candidate.branch) === norm(target.branch)
  );
}

const deny = (rule: ProtectRule, reason: string, dir?: string): ProtectDecision => ({
  decision: "DENY",
  rule,
  reason,
  ...(dir ? { dir } : {}),
});

/** The QA rules. They need no SoT, so they apply even with the gate off:
 * a QA lane is never claimed as implementation work, and a lane parked in
 * qa_wait is QA's work until it moves on. */
export function decideQaRole(candidate: ProtectCandidate, via: ProtectGateVia): ProtectDecision | null {
  if (candidate.role === "qa") {
    return deny("qa_role", `lane ${candidate.laneId} is QA work (role qa); implementer claim APIs cannot take it`);
  }
  if (via === "claim" && candidate.phase === "qa_wait") {
    return deny("qa_phase", `lane ${candidate.laneId} is in qa_wait; its frozen tip belongs to QA, not an implementer claim`);
  }
  return null;
}

/** Mirror of CoS eligibility decide() for one writer claim against a loaded
 * SoT. Order: QA rules, frozen tips, protected sessions, then ALLOW. */
export function decide(candidate: ProtectCandidate, sot: ProtectSoT, via: ProtectGateVia = "claim"): ProtectDecision {
  const qa = decideQaRole(candidate, via);
  if (qa) return { ...qa, dir: sot.dir };
  for (const tip of sot.frozenTips) {
    const at = `${tip.repo}@${tip.branch} (${tip.tipSha})${tip.reason ? ` — ${tip.reason}` : ""}`;
    if (sameRepoBranch(candidate, tip)) return deny("frozen_tip", `same repo+branch as frozen tip ${at}`, sot.dir);
    if (tip.worktreePath && pathsNest(candidate.worktreePath, tip.worktreePath)) {
      return deny("frozen_tip", `same worktree ${tip.worktreePath} as frozen tip ${at}`, sot.dir);
    }
    if (candidate.fullSha && candidate.fullSha.toLowerCase() === tip.tipSha) {
      return deny("frozen_tip", `lane tip ${candidate.fullSha} is frozen tip ${at}`, sot.dir);
    }
  }
  for (const session of sot.sessions) {
    const who = `protected session ${session.sessionId}${session.reason ? ` — ${session.reason}` : ""}`;
    if (candidate.writerTarget && candidate.writerTarget.trim() === session.sessionId) {
      return deny("protected_session", `writer target is ${who}`, sot.dir);
    }
    if (sameRepoBranch(candidate, session)) {
      return deny("protected_session", `same repo+branch ${session.repo}@${session.branch} as ${who}`, sot.dir);
    }
    if (session.worktreePath && pathsNest(candidate.worktreePath, session.worktreePath)) {
      return deny("protected_session", `same worktree ${session.worktreePath} as ${who}`, sot.dir);
    }
  }
  return { decision: "ALLOW", rule: "allow", reason: "disjoint from protected sessions and frozen tips", dir: sot.dir };
}

/** Whole gate for one candidate: QA rules always; SoT rules when a protect
 * directory is configured, failing closed if it cannot be loaded. Returns
 * null when the gate is off and the QA rules pass (ownership-only mode). */
export function evaluateProtectGate(
  candidate: ProtectCandidate,
  options: { protectDir?: string; via?: ProtectGateVia; sot?: ProtectLoadResult } = {},
): ProtectDecision | null {
  const via = options.via ?? "claim";
  const dir = options.sot ? (options.sot.ok ? options.sot.sot.dir : options.sot.dir) : resolveProtectDir(options.protectDir);
  if (!dir) return decideQaRole(candidate, via);
  const loaded = options.sot ?? loadProtectSoT(dir);
  if (!loaded.ok) return deny("config", `protect SoT unavailable, failing closed: ${loaded.reason}`, dir);
  return decide(candidate, loaded.sot, via);
}
