# Shared skills

Canonical home for skills that are rolled out to the product repositories. A target repository never holds the source of truth: it holds a generated, provenance-tracked adapter.

- `product-discovery-build/` - the Product Discovery & Build workflow (`manifest.json` records its version, origin archive hash and content hash).
- `scripts/skill-sync.mjs` - generates adapters. Dry run by default.

## Sync

```
node scripts/skill-sync.mjs --target <repo> [--hosts agents,claude,grok] [--source-ref <sha>]          # dry run
node scripts/skill-sync.mjs --target <repo> --apply --source-ref <sha>                                  # write
node scripts/skill-sync.mjs --target <repo> --apply --update-stale --source-ref <sha>                   # refresh stale copies
node scripts/skill-sync.mjs --check-source                                                              # manifest matches canonical
```

- Hosts default to the skill folders the target already has (`.agents/skills`, `.claude/skills`, `.grok/skills`, `.cursor/skills`). Pass `--hosts` to choose.
- Each adapter gets `PROVENANCE.json` (skill, version, canonical content hash, source repo/ref, per-file hashes). It is identical across hosts, so mirrored copies compare equal.
- No clobber: an existing folder without `PROVENANCE.json` is a COLLISION, and a copy edited after generation is MODIFIED. Neither is touched. An older generated copy is STALE and is replaced only with `--update-stale`. Re-running with nothing changed writes nothing.
- Copies of the skill in host folders that were not selected are listed as UNMANAGED and left alone.
- A short pointer block is appended to the target's `AGENTS.md`, outside any managed policy block. It is skipped when the repository has no `AGENTS.md`.
- After changing the canonical skill, bump `version` in `manifest.json`, run `--write-manifest`, then re-sync targets.

A host folder existing is not evidence that a host loads the skill. Record loader evidence per host separately.

## New repositories

There was no existing future-repository template. The smallest addition is this checklist, to run when a repository is created:

1. Add `AGENTS.md` (with the shared agents policy block).
2. Run the sync dry run with `--hosts` set to the hosts the project uses, review it, then `--apply`.
3. Commit the adapters and pointer in the repository's first PR.
