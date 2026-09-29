// A bot's memory on an OMB Cloud home, as far as a lent Mac is concerned
// (docs/cloud-pro.md, "Let my Cloud use this Mac").
//
// MEMORY.md is loaded into every turn of a bot, its topic files and daily
// log feed recall, and the owner's lending turns are among those turns. So a
// line put there by a conversation the owner did not write (a guest's chat,
// a room, a webhook run) would steer a turn that can reach the Mac. The
// harness's own memory writers already refuse such conversations
// (server/index.ts); this catches everything else, a bot writing the files
// directly with its own file tools included:
//
// - while a turn that is not provably the owner's runs for a bot, that bot's
//   memory is "pending";
// - when the files change while pending, the memory is "changed by someone
//   else" and the bot's turns cannot use the Mac until the owner reviews it
//   (the Memory panel, one click, no confirmation);
// - any other change (the owner's own turns, the owner's edits, upkeep on
//   the owner's conversations, the nightly tidy) is adopted as the owner's;
// - a write the harness makes for the owner (trustedWrite: upkeep on the
//   owner's conversations, their daily log line, their bot's memory tools)
//   is adopted even while such a turn runs, as long as nothing else changed
//   the memory first. A foreign write racing it within the same moment is
//   the one case this cannot tell apart.
//
// A change is judged by the content of MEMORY.md, memory/*.md and
// memory/log/*.md. It cannot stop a shell a guest directs from writing later
// (after the pending window), or from editing this record: a guest who can
// drive a Full-access bot on the Cloud already controls the machine.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

/** One hash over what a bot's memory says: MEMORY.md, every topic file and
 * every daily log, by name and content. Missing files hash as absent. */
export function memoryFingerprint(workspace: string): string {
  const hash = createHash("sha256");
  const add = (name: string, file: string) => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) return;
      hash.update(`${name}\u0000${stat.size}\u0000`).update(readFileSync(file)).update("\u0000");
    } catch { /* absent */ }
  };
  const list = (dir: string) => { try { return readdirSync(dir).filter(name => name.endsWith(".md")).sort(); } catch { return []; } };
  add("MEMORY.md", join(workspace, "MEMORY.md"));
  for (const name of list(join(workspace, "memory"))) add(`memory/${name}`, join(workspace, "memory", name));
  for (const name of list(join(workspace, "memory", "log"))) add(`memory/log/${name}`, join(workspace, "memory", "log", name));
  return hash.digest("hex");
}

const record = z.object({ trusted: z.string().regex(/^[a-f0-9]{64}$/), flagged: z.literal(true).optional(), pending: z.literal(true).optional() }).strict();
const recordsFile = z.object({ version: z.literal(1), bots: z.record(z.string().max(128), record) }).strict();
type Record = z.infer<typeof record>;

export interface LendingMemoryDeps {
  file: string;
  fingerprint: (botId: string) => string;
  log?: (line: string) => void;
}

export function createLendingMemory({ file, fingerprint, log = () => {} }: LendingMemoryDeps) {
  let bots: { [botId: string]: Record } = {};
  try {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      // A damaged or linked record flags nothing and trusts nothing: every
      // bot starts over from its memory as it is now.
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000) bots = recordsFile.parse(JSON.parse(readFileSync(file, "utf8"))).bots;
    }
  } catch { bots = {}; }
  const save = () => writeFileAtomic(file, JSON.stringify({ version: 1, bots }), { mode: 0o600 });
  const set = (botId: string, next: Record) => {
    const before = JSON.stringify(bots[botId] ?? null);
    bots = { ...bots, [botId]: next };
    if (JSON.stringify(next) !== before) save();
  };
  return {
    /** A turn that is not provably the owner's starts for this bot. Its
     * memory as it is now is the last one known to be the owner's, unless a
     * record already says otherwise. */
    noteForeignTurn(botId: string) {
      const current = bots[botId];
      set(botId, current ? { ...current, pending: true } : { trusted: fingerprint(botId), pending: true });
    },
    /** Judge the files now. `foreignRunning`: such a turn still runs. */
    reconcile(botId: string, foreignRunning: boolean): { changedBySomeoneElse: boolean } {
      const now = fingerprint(botId);
      const current = bots[botId];
      if (!current) { set(botId, { trusted: now, ...(foreignRunning ? { pending: true as const } : {}) }); return { changedBySomeoneElse: false }; }
      if (current.flagged) return { changedBySomeoneElse: true };
      if (now !== current.trusted) {
        if (current.pending) {
          log(`lending: memory of bot ${botId} changed while a conversation the owner did not write was running; its turns cannot use the lent Mac until the owner reviews it`);
          set(botId, { ...current, flagged: true });
          return { changedBySomeoneElse: true };
        }
        set(botId, { trusted: now });
        return { changedBySomeoneElse: false };
      }
      if (current.pending && !foreignRunning) set(botId, { trusted: current.trusted });
      return { changedBySomeoneElse: false };
    },
    /** A write the harness makes on the owner's behalf. Adopted as the
     * owner's when the memory was still exactly as trusted just before it;
     * otherwise left for reconcile to judge. */
    trustedWrite<T>(botId: string, write: () => T): T {
      const current = bots[botId];
      const before = fingerprint(botId);
      const result = write();
      if (!current) set(botId, { trusted: fingerprint(botId) });
      else if (!current.flagged && before === current.trusted) set(botId, { ...current, trusted: fingerprint(botId) });
      return result;
    },
    /** Whether the owner has a change to review (no file access). */
    needsReview(botId: string): boolean { return bots[botId]?.flagged === true; },
    /** The owner looked at the memory and accepts it as it is now. */
    review(botId: string, foreignRunning: boolean) {
      set(botId, { trusted: fingerprint(botId), ...(foreignRunning ? { pending: true as const } : {}) });
    },
    forget(botId: string) { if (bots[botId]) { const next = { ...bots }; delete next[botId]; bots = next; save(); } },
  };
}
