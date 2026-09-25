# Memory: recall, upkeep and the tidy-up

Automatic recall, the topic index and until dates are on for every bot and
only read memory. Memory upkeep (background capture, About me suggestions and
the nightly tidy-up) is a per-bot switch, off by default, and writes only
journaled, undoable rows. See [the memory guide](../memory.md).

## Exercise the real path

```sh
pnpm exec vitest run server/memory-layer.e2e.test.ts
pnpm exec vitest run server/memory-entries.test.ts server/recall.test.ts server/memory-upkeep.test.ts server/workspace.test.ts
pnpm exec vitest run src/components/bot-settings/MemorySection.test.ts src/lib/memory.test.ts server/drivers/agents-catalog-wire.test.ts
```

The API fixture launches the shared isolated server with the fake engine. The
capture and tidy-up model calls are answered by `FAKE_CLAUDE_TEXT_ROUTES`, a
JSON file mapping a prompt marker (`CAPTURE_MARKER`, `TIDY_MARKER`) to a
reply, re-read on every call so a step can change it. `FAKE_CLAUDE_PROMPTS`
records every turn the engine received, which is where recall shows.

Evidence covers:

- A topic file is listed with its title and aliases, and found by an alias the text never uses.
- A fact said in one chat is recalled in a new chat, named by its source.
- An entry past its until date leaves the prompt; one without a date stays.
- Upkeep off: nothing is captured and **Tidy up now** is refused.
- Upkeep on: facts are appended as dated, `(noticed)` entries with their until date, journaled as upkeep.
- `Balance is -10` captured twice is kept once; `Balance is 10` is a different fact.
- A fact about the person waits as a suggestion; Add writes a dated, attributed line to About me that reaches the prompt; a second Add is refused.
- The tidy-up archives the expired entry and strikes the contradicted one, reports it, and Undo restores the file.

Unit tests add the share limit on small notebooks (no contradiction change below
five entries), the nightly schedule (once a day after the hour, never while the
bot is busy, catching up after sleep), backup pauses, and engines without a
one-shot text call.

## Not proven here

The fake engine answers the model steps with scripted JSON, so these tests
prove the plumbing, not the quality of what a real model captures or judges
contradictory. Check that by hand with a real Claude bot: switch upkeep on,
mention a preference in passing, wait two minutes, and read the Memory panel.
