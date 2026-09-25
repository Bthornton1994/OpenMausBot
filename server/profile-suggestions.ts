// Suggestions for the shared About me, from bots with Memory upkeep on.
// About me rides into every bot's prompt, so nothing reaches it without the
// person: capture proposes a durable fact about them, it waits here, and
// Settings → About me offers Add or Dismiss. A dismissed fact is remembered
// (by identity only) so the same suggestion does not come back.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { factIdentity } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

export const MAX_PENDING = 50;
const MAX_DISMISSED = 500;
const TEXT_MAX = 300;

export interface ProfileSuggestion {
  id: string;
  text: string;
  botId: string;
  botName: string;
  at: number;
}

interface SuggestionFile {
  pending: ProfileSuggestion[];
  dismissed: string[];
}

function filePath(): string {
  return join(DATA_DIR, "profile-suggestions.json");
}

function load(): SuggestionFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<SuggestionFile>;
    const pending = Array.isArray(parsed.pending)
      ? parsed.pending.filter((s): s is ProfileSuggestion =>
        Boolean(s) && typeof s.id === "string" && typeof s.text === "string" && typeof s.botId === "string" && typeof s.botName === "string" && typeof s.at === "number")
      : [];
    const dismissed = Array.isArray(parsed.dismissed) ? parsed.dismissed.filter((d): d is string => typeof d === "string") : [];
    return { pending, dismissed };
  } catch {
    return { pending: [], dismissed: [] };
  }
}

function save(file: SuggestionFile): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export function listProfileSuggestions(): ProfileSuggestion[] {
  return load().pending;
}

/** Add what is new: not pending, not dismissed before, not already a line of
 * About me. Returns the suggestions actually added. */
export function suggestProfileFacts(from: { botId: string; botName: string }, texts: readonly string[], aboutMe: string, now = Date.now()): ProfileSuggestion[] {
  if (!texts.length) return [];
  const file = load();
  const known = new Set([
    ...file.pending.map((s) => factIdentity(s.text)),
    ...file.dismissed,
    ...aboutMe.split("\n").map((line) => factIdentity(line.replace(/^\s*-\s*\d{4}-\d{2}-\d{2} · learned by [^·\n]* · /, ""))),
  ]);
  const added: ProfileSuggestion[] = [];
  for (const raw of texts) {
    const text = redactSecretsInText(raw.replace(/\s+/g, " ").trim()).slice(0, TEXT_MAX);
    const key = factIdentity(text);
    if (!key || known.has(key)) continue;
    known.add(key);
    added.push({ id: randomUUID(), text, botId: from.botId, botName: from.botName, at: now });
  }
  if (!added.length) return [];
  // newest kept when full: an old unanswered suggestion matters least
  file.pending = [...file.pending, ...added].slice(-MAX_PENDING);
  save(file);
  return added.filter((s) => file.pending.includes(s));
}

/** Take one suggestion out of the pending list; a dismissal is remembered. */
export function resolveProfileSuggestion(id: string, action: "add" | "dismiss"): ProfileSuggestion | null {
  const file = load();
  const found = file.pending.find((s) => s.id === id);
  if (!found) return null;
  file.pending = file.pending.filter((s) => s.id !== id);
  if (action === "dismiss") file.dismissed = [...file.dismissed, factIdentity(found.text)].slice(-MAX_DISMISSED);
  save(file);
  return found;
}

/** A suggestion as the line About me gains: dated and attributed, like a
 * memory entry, so the person can see where it came from. */
export function aboutMeLine(suggestion: ProfileSuggestion, today: string): string {
  return `- ${today} · learned by ${suggestion.botName.replace(/·/g, "-").replace(/\s+/g, " ").trim().slice(0, 60)} · ${suggestion.text}`;
}

/** About me with the line appended, or null when it would pass the limit. */
export function appendAboutMe(aboutMe: string, line: string, maxChars = 24_000): string | null {
  const base = aboutMe.replace(/\s+$/, "");
  const next = base ? `${base}\n${line}` : line;
  return next.length > maxChars ? null : next;
}
