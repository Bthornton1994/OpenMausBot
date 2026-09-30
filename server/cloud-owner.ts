// An OMB Cloud home is personal (docs/cloud-pro.md): only the owner's own
// devices connect, each with an admin session the Admin's signed pairing
// gave it. No pairing, sign-in or session without admin scope is minted or
// redeemed there (server/sessions.ts requireAdmin), and at every boot any
// that is stored is revoked: what it opened or wrote is nobody's from then
// on, and its key is recorded first, so no crash can ever make it the
// owner's.
//
// Before, every device carried its own key (v0.1.91), so a device the owner
// unpaired made the owner's conversations read as someone else's. Once, at
// the first boot of a personal Cloud home, and again after a restore, the
// keys named until then are settled, in two tiers:
// - adopted: every key that opened a conversation, wrote a line or answered
//   a card, except a revoked one. Its conversations are the owner's for who
//   opened them, their approval level and their folder (so the owner's rooms
//   and conversations keep Auto or Full, and their project folder);
// - proven: only a key with proof it was the owner's, an admin session
//   still paired, or one that answered a card (only the owner's devices
//   could, on a Cloud home). Only those feed lending, memory, recall and the
//   recent-work brief (cloud-lending.ts ownerOnlyConversation): a guest the
//   owner unpaired before is indistinguishable from an owner's old device,
//   so its lines never count as the owner's there.
// Routines fail closed: a routine's writer is the owner only with proof (the
// owner's key as its writer, the owner's fingerprint, #2023, or a restore
// the owner started); every other routine is nobody's, and runs confined.
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const CLOUD_PERSONAL_REFUSAL = "Cloud Pro is personal: only your own devices can connect.";

const KEY = /^p_[\w-]{22}$/;
const keys = z.array(z.string().regex(KEY)).max(100_000);
const recordFile = z.object({
  version: z.literal(2),
  machineId: z.string().max(128),
  /** Revoked here, ever: never anyone's but nobody's. */
  revokedKeys: keys,
  adoptedKeys: keys,
  provenKeys: keys,
  /** The earlier keys are settled (and routines named). */
  settled: z.boolean(),
  /** A restore applied here whose data is not settled yet. */
  pendingRestore: z.string().max(128).optional(),
}).strict();
type OwnershipRecord = z.infer<typeof recordFile>;

/** Something that names people by key: thread openers, routine writers. */
export interface PeopleRecord {
  people(): Iterable<string>;
  reassign(move: (person: string) => boolean, to: string): number;
}

export interface CloudOwnershipOptions {
  /** <data>/cloud-owner.json, 0600, never in a backup (workspace-backup.ts). */
  file: string;
  machineId: string;
  ownerKey: string;
  nobodyKey: string;
  sessions: {
    list(): readonly { id: string; email?: string; scopes: readonly string[] }[];
    revoke(id: string): boolean;
  };
  personKey(session: { id: string; email?: string }): string;
  starters: PeopleRecord;
  writers: PeopleRecord;
  /** Each routine, its recorded writer, and whether the owner's fingerprint
   * is on it as it stands (#2023); `name` records its writer. */
  routines: { ids(): Iterable<string>; writer(id: string): string | undefined; fingerprinted(id: string): boolean; name(id: string, person: string): void };
  /** Everyone who wrote a user line (not a bot's) and who answered a card, anywhere. */
  lines(): { senders: Iterable<string>; answerers: Iterable<string> };
  /** The id of a restore applied at this boot: what it brought is the owner's. */
  restoredNow?: string;
  log(line: string): void;
}

export interface CloudOwnership {
  /** Earlier keys that opened, wrote or answered: the owner's for who opened
   * a conversation, its approval level and its folder. */
  adopted: ReadonlySet<string>;
  /** Earlier keys proven the owner's: also for lending and memory. */
  proven: ReadonlySet<string>;
}

function readRecord(options: CloudOwnershipOptions): OwnershipRecord {
  const fresh: OwnershipRecord = { version: 2, machineId: options.machineId, revokedKeys: [], adoptedKeys: [], provenKeys: [], settled: false };
  let stat;
  try { stat = lstatSync(options.file, { throwIfNoEntry: false }); } catch { stat = null; }
  if (stat === undefined) return fresh;
  try {
    if (!stat || !stat.isFile() || stat.size > 16_000_000) throw new Error("not a file");
    const record = recordFile.parse(JSON.parse(readFileSync(options.file, "utf8")));
    // Another machine's (never carried by a backup): nothing in it is ours.
    if (record.machineId !== options.machineId) {
      options.log(`cloud home: ${options.file} is another machine's; settling this one's own`);
      return fresh;
    }
    return record;
  } catch {
    // Settled before, and unreadable now: nothing earlier is the owner's, and
    // running the settlement again could make a revoked key theirs.
    options.log(`cloud home: ${options.file} is unreadable, so nothing from before is treated as the owner's`);
    return { ...fresh, settled: true };
  }
}

function save(options: CloudOwnershipOptions, record: OwnershipRecord): boolean {
  try {
    writeFileAtomic(options.file, JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch (error) {
    options.log(`cloud home: could not record who is the owner (${error instanceof Error ? error.message : String(error)}); trying again at the next start`);
    return false;
  }
}

/** A step that never stops the server from starting: logged when it fails
 * (`failed` is then called), and done again at the next start (every step
 * can be). */
function attempt<T>(options: CloudOwnershipOptions, what: string, step: () => T, fallback: T, failed?: () => void): T {
  try { return step(); } catch (error) {
    options.log(`cloud home: could not ${what} (${error instanceof Error ? error.message : String(error)})`);
    failed?.();
    return fallback;
  }
}

/** The settled keys, never one revoked since. */
function settledSets(record: OwnershipRecord): CloudOwnership {
  const revoked = new Set(record.revokedKeys);
  return { adopted: new Set(record.adoptedKeys.filter((key) => !revoked.has(key))), proven: new Set(record.provenKeys.filter((key) => !revoked.has(key))) };
}

/** Revoke every session that is not one of the owner's devices, and settle
 * the earlier keys (once, and after a restore). Every step is recorded
 * before it is taken, so a crash anywhere, or a failed save, only ever
 * leaves a key less trusted, and the next start carries on. */
export function settleCloudOwnership(options: CloudOwnershipOptions): CloudOwnership {
  let record = readRecord(options);
  const others = options.sessions.list().filter((session) => !session.scopes.includes("admin"));
  const revoked = new Set([...record.revokedKeys, ...others.map((session) => options.personKey(session))]);
  record = { ...record, revokedKeys: [...revoked], ...(options.restoredNow ? { pendingRestore: options.restoredNow } : {}) };
  // 1. The keys about to be revoked are recorded first.
  if (!save(options, record)) return settledSets(record);
  // 2. Their sessions go.
  let count = 0;
  for (const session of others) if (attempt(options, "revoke a session", () => options.sessions.revoke(session.id), false)) count += 1;
  options.log(`cloud home: revoked ${count} session${count === 1 ? "" : "s"} that ${count === 1 ? "was" : "were"} not the owner's own device${count === 1 ? "" : "s"}`);
  // 3. What any revoked key opened or wrote is nobody's.
  for (const [what, people] of [["mark conversations as nobody's", options.starters], ["mark routines as nobody's", options.writers]] as const) {
    attempt(options, what, () => people.reassign((person) => revoked.has(person), options.nobodyKey), 0);
  }
  const restoring = record.pendingRestore !== undefined;
  if (record.settled && !restoring) return settledSets(record);
  // 4. The earlier keys, recorded before anything is rewritten.
  const eligible = (person: string) => KEY.test(person) && person !== options.ownerKey && person !== options.nobodyKey && !revoked.has(person);
  // Settled only once every step below is done; else the next start does it again.
  let complete = true;
  const incomplete = () => { complete = false; };
  const lines = attempt(options, "read who wrote in each conversation", () => options.lines(), { senders: [], answerers: [] }, incomplete);
  const admins = options.sessions.list().filter((session) => session.scopes.includes("admin")).map((session) => options.personKey(session));
  const proven = new Set([...record.provenKeys, ...admins, ...lines.answerers].filter(eligible));
  const adopted = new Set([...record.adoptedKeys, ...proven, ...options.starters.people(), ...lines.senders].filter(eligible));
  record = { ...record, adoptedKeys: [...adopted], provenKeys: [...proven] };
  if (!save(options, record)) return settledSets(record);
  // 5. Conversations the owner provably opened name the owner; routines are
  // the owner's only with proof, else nobody's.
  const moved = attempt(options, "name the owner on their conversations", () => options.starters.reassign((person) => proven.has(person), options.ownerKey), 0, incomplete);
  let owners = 0, nobodys = 0;
  attempt(options, "name each routine's writer", () => {
    for (const id of options.routines.ids()) {
      const writer = options.routines.writer(id);
      const owner = writer === options.ownerKey || options.routines.fingerprinted(id) ||
        (restoring && writer !== options.nobodyKey && !(writer !== undefined && revoked.has(writer)));
      if (writer !== (owner ? options.ownerKey : options.nobodyKey)) options.routines.name(id, owner ? options.ownerKey : options.nobodyKey);
      if (owner) owners += 1; else nobodys += 1;
    }
  }, undefined, incomplete);
  if (!complete) return settledSets(record);
  const { pendingRestore: _done, ...rest } = record;
  record = { ...rest, settled: true };
  save(options, record);
  options.log(`cloud home: settled what came before${restoring ? " (a restore)" : ""}: ${adopted.size} earlier device key${adopted.size === 1 ? "" : "s"} (${proven.size} proven), ${moved} conversation${moved === 1 ? "" : "s"} named the owner's, ${owners} routine${owners === 1 ? "" : "s"} the owner's and ${nobodys} nobody's`);
  return settledSets(record);
}
