# Host discovery and adapters

This skill is canonical text. A host adapter only makes it discoverable; it grants no tools, permissions, or approval authority. A file or folder being present is not evidence that a host loads the skill. Record loader evidence per host.

## Status of each host

| Host | Candidate location | Loader evidence |
|---|---|---|
| Claude Code | repo `.claude/skills/universal-pre-launch-gate/` or the user skill library | UNKNOWN. Not tested; no adapter has been loaded from any location. |
| Codex | repo `.agents/skills/universal-pre-launch-gate/` or the user skill library | UNKNOWN. Not tested. |
| Cursor | repo `.cursor/skills/universal-pre-launch-gate/` or `.agents/skills/` | UNKNOWN. Not tested; local, cloud, and remote workers must be checked separately. |
| Grok Build | project `.grok/skills/universal-pre-launch-gate/` | UNKNOWN. Not tested. |
| Grok Bot | saved-skill library | UNKNOWN. Filesystem discovery not assumed. |
| OpenMausBot | no filesystem adapter assumed | UNKNOWN. If no skill importer exists, paste `SKILL.md` and the references into the task prompt. |

Only add a host to "verified" after a harmless discovery test shows the host listed the skill and read its references.

## How a future project invokes it

1. Place or generate the adapter in the project's host skill folder (generated from the canonical source, not hand-edited).
2. Ask the host to use `universal-pre-launch-gate` for the release candidate, naming repository, branch, exact SHA, platforms, environment, and launch requirements.
3. If the skill is not found, give the host the canonical `SKILL.md` and `references/` directly and report the missing adapter.

## Keeping one source

The canonical source is `Bthornton1994/OpenMausBot` `standards/shared-skills/universal-pre-launch-gate/`. Generate adapters with that repository's `scripts/skill-sync.mjs`, which stamps each copy with provenance (version, content hash, source repo and ref). Do not edit adapters; change the canonical skill and re-sync.
