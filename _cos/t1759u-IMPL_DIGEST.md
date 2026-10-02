# t1759u IMPL digest — catalog N1 overlay supersets

Implementer only. F-6 stays an accepted residual and was not touched.

## SHAs

| | SHA |
| --- | --- |
| before | `367822cd3a5c8c9dc3ed9c16c2e32cb5c446a495` |
| after | `e65cb3fc2d00bcf3d25406891c603b25215fe02d` |

`e65cb3fc2d00bcf3d25406891c603b25215fe02d` is the implementation commit (parent = before). This digest line is recorded in the child of that commit, so `git rev-parse HEAD` is the branch tip and `git rev-parse HEAD^` is the after SHA above.

PR #1 (`cos/t1753u-omb-main-integrate`, draft) was still `367822cd3a5c8c9dc3ed9c16c2e32cb5c446a495` immediately before this commit. This branch does not update that ref.

## Files

- `server/factory-task-patterns.ts` — overlay `stopConditions` and `verificationEvidence` must be supersets of the built-in lists; a missing key inherits the built-in; a drop or replacement fails closed with `overlay_not_narrow`. Role and action narrowing is unchanged.
- `server/factory-task-patterns.test.ts` — superset allow, drop stop deny, drop evidence deny, omit-field inherit. The old “missing stopConditions is invalid_pattern” case now deletes `objective`, because omitting stop/evidence is legal.
- `docs/factory-task-patterns.md` — one sentence on the superset rule, plus the new error code in the existing code list.

## Assumptions

| Assumption | Label | Repo evidence |
| --- | --- | --- |
| Start at `367822cd` and do not move PR #1 | verified | `git rev-parse HEAD` before the branch; `gh pr view 1` headRefOid matched, headRefName `cos/t1753u-omb-main-integrate` |
| `assertNarrows` only checked role, permitted-action subset, and forbidden-action superset, then the overlay object replaced the built-in | verified | `server/factory-task-patterns.ts` `assertNarrows` and `merged.set` before this change |
| Inherit-on-omit applies only while loading an overlay whose id is a built-in. `validatePattern` still requires both fields | inferred | `REQUIRED_FIELDS` still lists both; task text is “when an overlay provides” those fields |
| Omit means the key is absent. `null`, `[]`, and a wrong type stay `invalid_pattern` | inferred | `validatePattern` treats null as missing; `textList` rejects empty lists. Present-but-bad stays fail-closed |
| Superset means every built-in string is still present (duplicates counted). Order may differ. Rewriting an entry is a drop | inferred | Task: “every built-in entry must still appear; overlay may only add.” Action checks already use exact string inclusion |
| New code `overlay_not_narrow`. Role and action failures stay `action_denied` | inferred | Brief names `overlay_not_narrow`; existing narrowing tests expect `action_denied` |
| The closed-lookup test that deleted `stopConditions` must delete a still-required field (`objective`) | verified | That test expected `invalid_pattern`; omit is now a successful inherit |
| No live app fixture. Focused vitest and typecheck are the check | verified | Brief run commands. This module is not an HTTP or MCP route |
| F-6, product repos, credentials, undraft/merge, and the integrate branch are out of scope | verified | Brief hard stops |

No high-impact unknown left. Node on this machine is v22.14.0 while `package.json` asks for `>=24`; pnpm warned, and both commands below still exited 0.

## Tests

```sh
pnpm exec vitest run server/factory-task-patterns.test.ts
```

Result: 1 file passed, 99 tests passed (vitest 4.1.10).

```sh
pnpm typecheck
```

Result: exit 0 (`tsc -b && tsc -p tsconfig.server.json`).

## Residuals

- F-6 per-bot auth: accepted residual, not this change.
- Superset is exact string membership, not a trimmed or case-folded match.
- An empty `stopConditions` or `verificationEvidence` array still fails `invalid_pattern` (list must be non-empty) before the superset check.
- Full `pnpm test` not run; Ubuntu CI owns that.
- Typecheck and vitest ran on Node v22.14.0 (engine warning only).
