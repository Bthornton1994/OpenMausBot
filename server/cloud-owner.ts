// An OMB Cloud home is personal (docs/cloud-pro.md): only the owner's own
// devices connect, each with an admin session the Admin's signed pairing
// gave it. No pairing, sign-in or session without admin scope is minted or
// redeemed there (server/index.ts, CLOUD_PERSONAL_REFUSAL), and at every
// boot any that exists is revoked. What the revoked sessions opened or wrote
// is marked as nobody's, so it can never read as the owner's.
//
// Once, at the first boot of a Cloud home that is personal, every other
// person named on it (a conversation's opener, a routine's writer, a device
// still paired) is the owner. Before, a conversation, a routine or a line
// carried the key of the device that wrote it, so a device later unpaired
// made the owner's own conversations read as someone else's. Openers and
// writers are rewritten to the owner's key, and the earlier keys are kept
// (cloud-owner.json) so the owner's older lines stay theirs too.
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

export const CLOUD_PERSONAL_REFUSAL = "Cloud Pro is personal: only your own devices can connect.";

const KEY = /^p_[\w-]{22}$/;
const recordFile = z.object({ version: z.literal(1), ownerKeys: z.array(z.string().regex(KEY)).max(100_000) }).strict();

/** Something that names people by key: thread openers, routine writers. */
export interface PeopleRecord {
  people(): Iterable<string>;
  reassign(move: (person: string) => boolean, to: string): number;
}

export interface CloudOwnershipOptions {
  /** <data>/cloud-owner.json, 0600. */
  file: string;
  sessions: {
    list(): readonly { id: string; email?: string; scopes: readonly string[] }[];
    revoke(id: string): boolean;
  };
  personKey(session: { id: string; email?: string }): string;
  starters: PeopleRecord;
  writers: PeopleRecord;
  ownerKey: string;
  nobodyKey: string;
  log(line: string): void;
}

/** A record's reassign, which never stops the server from starting: kept in
 * memory for this run when it cannot be saved. */
function reassign(record: PeopleRecord, move: (person: string) => boolean, to: string, log: (line: string) => void): number {
  try { return record.reassign(move, to); } catch (error) {
    log(`cloud home: could not save who opened or wrote what (${error instanceof Error ? error.message : String(error)})`);
    return 0;
  }
}

/** Revoke every session that is not one of the owner's devices, and (once)
 * settle who the owner was before. Returns the owner's earlier keys. */
export function settleCloudOwnership(options: CloudOwnershipOptions): ReadonlySet<string> {
  const others = options.sessions.list().filter((session) => !session.scopes.includes("admin"));
  const revokedKeys = new Set(others.map((session) => options.personKey(session)));
  let revoked = 0;
  for (const session of others) if (options.sessions.revoke(session.id)) revoked += 1;
  options.log(`cloud home: revoked ${revoked} session${revoked === 1 ? "" : "s"} that ${revoked === 1 ? "was" : "were"} not the owner's own device${revoked === 1 ? "" : "s"}`);
  const records = [options.starters, options.writers];
  for (const record of records) reassign(record, (person) => revokedKeys.has(person), options.nobodyKey, options.log);

  let exists = true;
  try { exists = Boolean(lstatSync(options.file, { throwIfNoEntry: false })); } catch { /* unknown: exists */ }
  if (exists) {
    try {
      const stat = lstatSync(options.file);
      if (!stat.isFile() || stat.size > 4_000_000) throw new Error("not a file");
      return new Set(recordFile.parse(JSON.parse(readFileSync(options.file, "utf8"))).ownerKeys);
    } catch {
      options.log(`cloud home: ${options.file} is unreadable, so nothing from before is treated as the owner's`);
      return new Set();
    }
  }
  const candidates = new Set<string>(options.sessions.list().map((session) => options.personKey(session)));
  for (const record of records) for (const person of record.people()) candidates.add(person);
  // (What the revoked sessions opened or wrote is nobody's by now, and they
  // are no longer listed.)
  const ownerKeys = [...candidates].filter((person) => KEY.test(person) && person !== options.ownerKey && person !== options.nobodyKey);
  // Recorded first: a migration that is not recorded does not happen (it
  // runs again at the next start, when it is safe to: what the sessions
  // revoked now opened is nobody's by then).
  try {
    writeFileAtomic(options.file, JSON.stringify({ version: 1, ownerKeys }), { mode: 0o600 });
  } catch (error) {
    options.log(`cloud home: could not record the owner's earlier devices (${error instanceof Error ? error.message : String(error)}); trying again at the next start`);
    return new Set();
  }
  const settled = new Set(ownerKeys);
  const moved = reassign(options.starters, (person) => settled.has(person), options.ownerKey, options.log);
  reassign(options.writers, (person) => settled.has(person), options.ownerKey, options.log);
  options.log(`cloud home: ${moved} conversation${moved === 1 ? "" : "s"} from before ${moved === 1 ? "is" : "are"} the owner's`);
  return settled;
}
