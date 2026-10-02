// Positive fixture: one finding per advisory rule (see anti-slop.test.ts).
type User = { id: string };

export function chained(input: string): User {
  // SAFETY: fixture for no-chained-type-assertions only.
  return input as unknown as User;
}

export function unjustified(input: object): User {
  return input as User;
}

export const loose: Record<string, any> = {};

export function widened(): User {
  const source = { id: "1" };
  const value: unknown = source;
  // SAFETY: fixture for no-widen-then-assert only.
  return value as User;
}

export function copyEach(users: readonly User[]): Record<string, User> {
  return users.reduce<Record<string, User>>((acc, user) => Object.assign({}, acc, { [user.id]: user }), {});
}
