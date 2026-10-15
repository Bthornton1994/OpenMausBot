import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("holds broad Chief of Staff work to a read-only provider surface", async () => {
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_MODE: "happy",
    FAKE_CLAUDE_VERSION: "2.1.284",
  });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result;
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    evidence.push({ method, path, result });
    return result;
  };
  try {
    const { bot } = await control(["new-bot", "--name", "Ambition Review fixture"]) as { bot: { id: string } };
    await api("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true });
    await control([
      "send", "--bot", bot.id,
      "--text", "Evaluate the project architecture and propose a migration plan.",
    ]);
    const waited = await control(["wait", "--bot", bot.id, "--timeout", "30"]);
    expect(waited).toMatchObject({ status: "settled" });
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);

    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as {
      argv: string[];
      systemPrompt?: string;
      mcpConfig?: unknown;
      prompt?: unknown;
    };
    evidence.push({ providerDump: dump });
    expect(dump.systemPrompt).toContain("For strategic, ambiguous, repeated, or multi-step project work");
    expect(dump.systemPrompt).toContain("Then stop and wait for the user's selection.");
    expect(JSON.stringify(dump.prompt)).toContain("Evaluate the project architecture and propose a migration plan.");
    expect(dump.argv).toContain("--restricted");
    expect(dump.argv).toContain("--strict-mcp-config");
    expect(dump.argv).toContain("--permission-mode");
    expect(dump.argv[dump.argv.indexOf("--permission-mode") + 1]).toBe("default");
    expect(dump.argv).toContain("--tools");
    expect(dump.argv[dump.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(dump.mcpConfig).toBeNull();
  } finally {
    await fixture.close();
    const evidencePath = `${fixture.info.logPath}.ambition-review.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved: true, exitCode: fixture.child.exitCode }));
  }
}, 60_000);
