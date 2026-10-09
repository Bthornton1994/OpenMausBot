# Shared skills

Canonical home for skills that are rolled out to the product repositories. A target repository never holds the source of truth: it holds a generated, provenance-tracked adapter.

- `product-discovery-build/` - the Product Discovery & Build workflow.
- `universal-pre-launch-gate/` - the 20-check, evidence-based pre-launch gate for any platform. Host loader evidence is UNKNOWN for every host (see its `references/host-adapters.md`).
- `manifest.json` - one entry per skill, keyed by skill name: version, origin and origin hash, changes from origin, content hash, and the `AGENTS.md` pointer text.
- `scripts/skill-sync.mjs` - generates adapters. Dry run by default.

## Sync

```
node scripts/skill-sync.mjs --target <repo> [--skills a,b] [--hosts agents,claude,grok] [--source-ref <sha>]   # dry run
node scripts/skill-sync.mjs --target <repo> --apply --source-ref <sha>                                           # write
node scripts/skill-sync.mjs --target <repo> --apply --update-stale --source-ref <sha>                            # refresh stale copies
node scripts/skill-sync.mjs --check-source [--skills a,b]                                                        # manifest matches canonical
```

- `--skills` defaults to every skill in `manifest.json`. Names must be lowercase letters and digits joined by single hyphens (at most 64 characters); anything else, or a name not in the manifest, is rejected before anything is read or written.
- Hosts default to the skill folders the target already has (`.agents/skills`, `.claude/skills`, `.grok/skills`, `.cursor/skills`). Pass `--hosts` to choose.
- Each adapter gets `PROVENANCE.json` (skill, version, canonical content hash, source repo/ref, per-file hashes). It is identical across hosts, so mirrored copies compare equal.
- No clobber: an existing folder without `PROVENANCE.json` is a COLLISION, and a copy edited after generation is MODIFIED. Neither is touched. An older generated copy is STALE and is replaced only with `--update-stale`. Re-running with nothing changed writes nothing. Each skill is classified separately, so a collision for one skill does not stop another.
- Copies of a skill in host folders that were not selected are listed as UNMANAGED and left alone.
- Each skill appends its own short pointer block to the target's `AGENTS.md`, outside any managed policy block and delimited by markers that carry the skill name, so re-runs never duplicate a block. It is skipped when the repository has no `AGENTS.md`.
- The exit code is 2 when any skill reports a COLLISION or MODIFIED destination, 1 on an error, and 0 otherwise. `--json` prints one report per skill.
- After changing a canonical skill, bump its `version` in `manifest.json`, run `--write-manifest`, then re-sync targets.

A host folder existing is not evidence that a host loads the skill. Record loader evidence per host separately.

## Adding a skill

1. Create `standards/shared-skills/<name>/` with `SKILL.md` (front matter `name: <name>`), plus `references/`, `agents/openai.yaml` and `assets/` as needed. The folder name follows the skill-name rule above.
2. Add a `manifest.json` entry under `skills.<name>` with `version`, `origin`, an origin hash, `changesFromOrigin`, and `pointer` (a `## Heading` and one paragraph telling agents when to read the skill and where its canonical source is). Leave `contentSha256` empty.
3. Run `node scripts/skill-sync.mjs --write-manifest --skills <name>`, then `--check-source`, then the `scripts/skill-sync.test.mjs` tests.
4. Record host loader evidence as UNKNOWN until a harmless discovery test on that host shows the skill listed and its references read.

## Adding a platform module to the pre-launch gate

Platform modules live in `universal-pre-launch-gate/references/platform-modules.md`. Follow the "Adding a new platform module" procedure there: map each of the 20 core checks to platform evidence, put platform-only risks under the nearest core check, and never copy, renumber, or weaken `references/core-checklist.md`. A module is a canonical change: bump the skill's version and refresh the manifest as above. Do not fork the gate into a per-platform skill.

## New repositories

There was no existing future-repository template. The smallest addition is this checklist, to run when a repository is created:

1. Add `AGENTS.md` (with the shared agents policy block).
2. Run the sync dry run with `--hosts` set to the hosts the project uses (and `--skills` if it needs only some skills), review it, then `--apply`.
3. Commit the adapters and pointers in the repository's first PR.
