// An OMB Cloud home is personal (docs/cloud-pro.md; server/cloud-owner.ts):
// only the owner's own devices connect. A server that had other people's
// sessions before (here: the same data, first served as an ordinary
// self-hosted server) loses them when it boots as a Cloud home, nothing
// mints or accepts another, and what the owner's own devices opened before
// stays theirs, even once the device that opened it is unpaired.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const PERSONAL = "Cloud Pro is personal: only your own devices can connect.";
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", port = 0, log = "";
let child: ChildProcess | undefined;
let cloud = false;
/** From the first (self-hosted) run: a device with full access, a chat-only one, and what each opened. */
const before = { device: "", deviceId: "", chatOnly: "", bot: { id: "", threadId: "" }, roomBot: { id: "", threadId: "" }, conversation: "", theirs: "",
  lead: { id: "", threadId: "" }, member: { id: "", threadId: "" }, room: "" };
const project = () => join(home, "projects", "site");

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cloud ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}
const held = () => join(home, "held.json");
/** Polls until `check` holds (expect.poll works only inside a test). */
let lastBusy = "";
async function until(check: () => boolean | Promise<boolean>, what: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} ${lastBusy}\n${log.slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** The level and folder of the next turn the held engine starts. */
async function turn(start: () => Promise<unknown>) {
  rmSync(held(), { force: true });
  await start();
  await until(() => existsSync(held()), "a turn to start");
  const dump = JSON.parse(readFileSync(held(), "utf8"));
  const argv = dump.argv as string[];
  return { mode: argv[argv.indexOf("--permission-mode") + 1], cwd: realpathSync(dump.cwd) };
}
const idle = (bot: { id: string }, token?: string) => until(async () =>
  (await api("GET", "/api/bots", { token })).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy === false, "the bot to settle");

async function boot(asCloud: boolean) {
  log = "";
  cloud = asCloud;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...(asCloud ? {
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function shutdown() { if (child) await waitForExit(child, { signal: "SIGTERM" }); child = undefined; }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-personal-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(project(), { recursive: true });
  const cli = join(home, "held-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(held())}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      held: { driver: "claudeAgent", displayName: "Held", config: { cli } },
    },
  }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  // First, an ordinary self-hosted server: a device with full access and a
  // chat-only one each open a conversation.
  await boot(false);
  const pair = async (scopes: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", { body: { label: scopes.join("+"), scopes } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token as string;
  };
  before.device = await pair(["admin", "client"]);
  before.deviceId = (await api("GET", "/api/auth/session", { token: before.device })).body.id;
  before.chatOnly = await pair(["client"]);
  const newBot = async (name: string) => {
    const bot = (await api("POST", "/api/bots", { token: before.device, body: { name, modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { token: before.device, body: { cwd: project(), approvalMode: "auto" } })).status).toBe(200);
    return bot as { id: string; threadId: string };
  };
  before.bot = await newBot("Site bot");
  before.conversation = (await api("POST", `/api/bots/${before.bot.id}/tasks`, { token: before.device, body: { title: "Before the upgrade" } })).body.task.threadId;
  // It ran in the project folder then.
  const first = await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token: before.device, body: { text: "Build the site.", threadId: before.conversation } }));
  expect(first).toEqual({ mode: "auto", cwd: realpathSync(project()) });
  await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: before.device, body: { threadId: before.conversation } });
  await idle(before.bot, before.device);
  // The chat-only device's own conversation is the room bot's active one.
  before.roomBot = await newBot("Room bot");
  before.theirs = (await api("POST", `/api/bots/${before.roomBot.id}/tasks`, { token: before.chatOnly, body: { title: "Theirs" } })).body.task.threadId;
  expect((await api("GET", "/api/bots", { token: before.device })).body.bots.find((bot: any) => bot.id === before.roomBot.id).threadId).toBe(before.theirs);
  // The device also wrote in a room of two bots.
  before.lead = await newBot("Lead");
  before.member = await newBot("Member");
  before.room = (await api("POST", "/api/groups", { token: before.device, body: { memberIds: [before.lead.id, before.member.id], name: "Team", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } })).body.group.id;
  await turn(() => api("POST", `/api/groups/${before.room}/messages`, { token: before.device, body: { text: "Plan the launch." } }));
  // Each member answers in turn: stop the room until both have settled.
  await until(async () => {
    await api("POST", `/api/groups/${before.room}/interrupt`, { token: before.device, body: {} });
    const bots = (await api("GET", "/api/bots", { token: before.device })).body.bots as any[];
    lastBusy = JSON.stringify(bots.filter((bot) => [before.lead.id, before.member.id].includes(bot.id)).map((bot) => ({ name: bot.name, busy: bot.busy, activity: bot.activity })));
    return [before.lead.id, before.member.id].every((id) => bots.find((bot) => bot.id === id)?.busy !== true);
  }, "the room to settle");
  await shutdown();
  // Then the same data boots as the person's Cloud home.
  await boot(true);
}, 90_000);

const proxies: ChildProcess[] = [];
/** The agents MCP tools of the held turn that just started. */
async function agentTools() {
  const agents = JSON.parse(readFileSync(held(), "utf8")).mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result ?? msg); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown) => request("tools/call", { name, arguments: args });
}

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await shutdown();
  if (home) await removeTempDir(home);
});

it("boots without anyone else's session: the chat-only device is signed out, and only the owner's devices are listed", async () => {
  expect(log).toContain("cloud home: revoked 1 session that was not the owner's own device");
  for (const path of ["/api/auth/session", "/api/bots", `/api/threads/${before.theirs}/messages`]) {
    expect((await api("GET", path, { token: before.chatOnly })).status, path).toBe(401);
  }
  expect((await api("POST", "/api/auth/stream-ticket", { token: before.chatOnly })).status).toBe(401);
  const owner = await adminPairing();
  const devices = (await api("GET", "/api/auth/sessions", { token: owner })).body.sessions as { scopes: string[] }[];
  expect(devices.length).toBe(2);
  for (const device of devices) expect(device.scopes).toContain("admin");
}, 30_000);

it("no route mints or accepts a session without admin scope: pairing, email sign-in and invites answer in one plain line", async () => {
  const owner = await adminPairing();
  const chatOnly = await api("POST", "/api/auth/pairing", { token: owner, body: { label: "Guest phone", scopes: ["client"] } });
  expect(chatOnly).toEqual({ status: 403, body: { error: PERSONAL, code: "cloud_personal" } });
  for (const path of ["/api/auth/email/start", "/api/auth/email/verify"]) {
    expect(await api("POST", path, { body: { email: "friend@example.test", code: "123456" } }), path).toEqual({ status: 403, body: { error: PERSONAL, code: "cloud_personal" } });
  }
  for (const signIn of [{ admins: [], members: ["friend@example.test"] }, { admins: ["friend@example.test"], members: [] }]) {
    expect((await api("PUT", "/api/config", { token: owner, body: { signIn } })).body.error).toBe(PERSONAL);
  }
  // The owner's own next device pairs as before.
  const own = await api("POST", "/api/auth/pairing", { token: owner, body: { label: "My phone", scopes: ["admin", "client"] } });
  expect(own.status).toBe(200);
  const paired = await api("POST", "/api/pair", { body: { credential: own.body.credential, deviceName: "My phone" } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
}, 30_000);

it("a conversation the owner's device opened before stays the owner's after that device is unpaired: same level, same folder", async () => {
  const owner = await adminPairing();
  expect((await api("DELETE", `/api/auth/sessions/${before.deviceId}`, { token: owner })).status).toBe(200);
  const after = await turn(() => api("POST", `/api/bots/${before.bot.id}/messages`, { token: owner, body: { text: "Carry on.", threadId: before.conversation } }));
  expect(after).toEqual({ mode: "auto", cwd: realpathSync(project()) });
  expect((await api("POST", `/api/bots/${before.bot.id}/interrupt`, { token: owner, body: { threadId: before.conversation } })).status).toBe(200);
  await idle(before.bot, owner);
}, 60_000);

it("the owner's room turn runs at the bot's own level, whichever of its conversations is active; the chat-only device's stays nobody's", async () => {
  const owner = await adminPairing();
  const room = (await api("POST", "/api/groups", { token: owner, body: { memberIds: [before.roomBot.id], name: "Owner's room", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } } })).body.group;
  const inRoom = await turn(async () => expect((await api("POST", `/api/groups/${room.id}/messages`, { token: owner, body: { text: "Run the setup script." } })).status).toBeLessThan(300));
  expect(inRoom.mode).toBe("auto");
  expect((await api("POST", `/api/groups/${room.id}/interrupt`, { token: owner, body: {} })).status).toBe(200);
  await idle(before.roomBot, owner);
  // What the chat-only device opened is still not the owner's (Ask, its own folder).
  const theirs = await turn(async () => expect((await api("POST", `/api/bots/${before.roomBot.id}/messages`, { token: owner, body: { text: "Hello.", threadId: before.theirs } })).status).toBe(202));
  expect(theirs.mode).toBe("default");
  expect(theirs.cwd).not.toBe(realpathSync(project()));
  expect((await api("POST", `/api/bots/${before.roomBot.id}/interrupt`, { token: owner, body: { threadId: before.theirs } })).status).toBe(200);
}, 60_000);

it("a line the owner's device wrote in a room before stays the owner's after that device is unpaired: work handed there runs at the bot's own level", async () => {
  const owner = await adminPairing();
  // (The device was unpaired above.)
  expect((await api("GET", "/api/auth/sessions", { token: owner })).body.sessions.some((session: any) => session.id === before.deviceId)).toBe(false);
  const mine = (await api("POST", `/api/bots/${before.lead.id}/tasks`, { token: owner, body: { title: "Mine" } })).body.task.threadId;
  await turn(async () => expect((await api("POST", `/api/bots/${before.lead.id}/messages`, { token: owner, body: { text: "Get the team going.", threadId: mine } })).status).toBe(202));
  const call = await agentTools();
  const handed = turn(async () => {
    const result = await call("coordinate_bots", { group_id: before.room, bot_ids: [before.member.id], message: "Draft the launch post.", request_key: "launch" });
    expect(JSON.stringify(result)).not.toContain("isError\":true");
  });
  expect((await handed).mode).toBe("auto");
  expect((await api("POST", `/api/groups/${before.room}/interrupt`, { token: owner, body: {} })).status).toBe(200);
  expect((await api("POST", `/api/bots/${before.lead.id}/interrupt`, { token: owner, body: { threadId: mine } })).status).toBe(200);
}, 60_000);
