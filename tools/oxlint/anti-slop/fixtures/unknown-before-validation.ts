// Negative fixture: parse into `unknown`, narrow at runtime, then use. None of
// the advisory anti-slop rules may report this file.
type User = { id: string; name: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUser(value: unknown): value is User {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

export function parseUser(raw: string): User {
  const value: unknown = JSON.parse(raw);
  if (!isUser(value)) throw new Error("invalid user");
  return value;
}

export function readFields(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  return isRecord(value) ? value : {};
}

export const ROLES = ["owner", "member"] as const;

export function countByName(users: readonly User[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const user of users) counts.set(user.name, (counts.get(user.name) ?? 0) + 1);
  return counts;
}
