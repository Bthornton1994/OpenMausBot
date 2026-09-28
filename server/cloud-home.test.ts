import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  CLOUD_HOME_MARKER, CLOUD_PAIRING_MAX_TTL_S, CLOUD_PAIRING_NONCE_MS, CLOUD_PAIRING_SKEW_S, cloudHomeConfiguration, cloudHomeConfigured,
  cloudHomeHost, cloudPairingSignature, createCloudPairing, prepareCloudHomeVolume,
} from "./cloud-home.ts";
import { cloudHomeChildEnvironments, passwdIds } from "./cloud-home-start.ts";
import { hostedModelPolicy } from "./hosted-models.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTempDir(directory); });
const directory = () => { const value = mkdtempSync(join(tmpdir(), "omb-cloud-home-")); directories.push(value); return value; };

// Shapes exactly as openmaus-cloud's provisioner writes them (cloud-machines.ts).
const secret = "S".repeat(43);
const token = `omb_cloudai_${"t".repeat(43)}`;
const machineId = "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93";
const gatewayUrl = "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd";
const contract = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: machineId, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
  OMB_PUBLIC_URL: "https://omb-u-1a2b3c4d5e6f.fly.dev", OMB_CLOUD_BOOTSTRAP_SECRET: secret, ...extra,
});
const withModels = (catalog: object = { anthropic: [], openai: ["gpt-5.6-sol"], openrouter: ["anthropic/claude-sonnet-5"] }) =>
  contract({ OMB_HOSTED_MODEL_URL: gatewayUrl, OMB_HOSTED_MODEL_TOKEN: token, OMB_HOSTED_MODELS: JSON.stringify(catalog) });

// ── boot contract ──────────────────────────────────────────────────────────

it("is off on every ordinary server and desktop", () => {
  expect(cloudHomeConfigured({})).toBe(false);
  expect(cloudHomeConfiguration({})).toBeNull();
  expect(cloudHomeConfiguration({ OMB_PUBLIC_URL: "https://selfhosted.example.test", OMB_HOSTED_MODELS: "{}" })).toBeNull();
});

it("reads the Admin's contract, with and without included models", () => {
  expect(cloudHomeConfiguration(contract())).toEqual({
    machineId, adminOrigin: "https://cloud.example.test", publicOrigin: "https://omb-u-1a2b3c4d5e6f.fly.dev", bootstrapSecret: secret, warnings: [],
  });
  const config = cloudHomeConfiguration(withModels())!;
  expect(config.gateway).toEqual({ base: gatewayUrl, token, openai: ["gpt-5.6-sol"], openrouter: ["anthropic/claude-sonnet-5"] });
  expect(config.warnings).toEqual([]);
  expect(cloudHomeConfiguration(contract({ OMB_CLOUD_ADMIN_URL: "https://cloud.example.test/" }))!.adminOrigin).toBe("https://cloud.example.test");
  expect(cloudHomeConfiguration({ ...withModels(), OMB_HOSTED_MODEL_URL: `${gatewayUrl}/` })!.gateway!.base).toBe(gatewayUrl);
});

it.each<[string, NodeJS.ProcessEnv]>([
  ["only one key", { OMB_CLOUD_MACHINE_ID: machineId }],
  ["no role", { ...contract(), OMB_CLOUD_ROLE: undefined }],
  ["the desktop role", contract({ OMB_CLOUD_ROLE: "desktop" })],
  ["no public URL", { ...contract(), OMB_PUBLIC_URL: undefined }],
  ["an http Admin", contract({ OMB_CLOUD_ADMIN_URL: "http://cloud.example.test" })],
  ["an Admin URL with a path", contract({ OMB_CLOUD_ADMIN_URL: "https://cloud.example.test/api" })],
  ["an Admin URL with credentials", contract({ OMB_CLOUD_ADMIN_URL: "https://user:pass@cloud.example.test" })],
  ["an http public URL", contract({ OMB_PUBLIC_URL: "http://omb-u-1a2b3c4d5e6f.fly.dev" })],
  ["a machine id with a slash", contract({ OMB_CLOUD_MACHINE_ID: "home/../x" })],
  ["a short secret", contract({ OMB_CLOUD_BOOTSTRAP_SECRET: "S".repeat(42) })],
  ["a secret with padding", contract({ OMB_CLOUD_BOOTSTRAP_SECRET: `${"S".repeat(42)}=` })],
  ["the desktop app", contract({ OMB_DESKTOP_PARENT: "1" })],
  ["a hosted team workspace too", contract({ OMB_ADMIN_URL: "https://cloud.example.test" })],
  ["a token without the rest", contract({ OMB_HOSTED_MODEL_TOKEN: token })],
  ["no gateway URL", { ...withModels(), OMB_HOSTED_MODEL_URL: undefined }],
  ["a workspace token", { ...withModels(), OMB_HOSTED_MODEL_TOKEN: `omb_workspace_${"t".repeat(43)}` }],
  ["a raw platform key", { ...withModels(), OMB_HOSTED_MODEL_TOKEN: "sk-ant-api03-platform-key" }],
  ["a gateway on another origin", { ...withModels(), OMB_HOSTED_MODEL_URL: "https://gateway.attacker.test/api/cloud/gateway/g1" }],
  ["an http gateway", { ...withModels(), OMB_HOSTED_MODEL_URL: gatewayUrl.replace("https:", "http:") }],
  ["a gateway with a query", { ...withModels(), OMB_HOSTED_MODEL_URL: `${gatewayUrl}?key=x` }],
  ["a gateway at the origin root", { ...withModels(), OMB_HOSTED_MODEL_URL: "https://cloud.example.test/" }],
  ["a malformed catalog", { ...withModels(), OMB_HOSTED_MODELS: "{not json" }],
  ["an unknown provider", withModels({ anthropic: [], openai: [], openrouter: ["a/b"], google: ["x"] })],
])("refuses to start with %s", (_why, env) => {
  expect(() => cloudHomeConfiguration(env)).toThrow(/Cloud home configuration is invalid/);
});

it("never runs Claude Code on included AI, and says so instead of failing the machine", () => {
  // openmaus-cloud's default catalog lists Claude under anthropic.
  const config = cloudHomeConfiguration(withModels({ anthropic: ["claude-sonnet-5", "claude-haiku-4-5"], openai: ["gpt-5.6-sol"], openrouter: [] }))!;
  expect(config.gateway).toEqual({ base: gatewayUrl, token, openai: ["gpt-5.6-sol"], openrouter: [] });
  expect(config.warnings).toEqual([expect.stringMatching(/ignoring 2 included anthropic model\(s\): Claude Code never runs on included AI/)]);
  const claudeOnly = cloudHomeConfiguration(withModels({ anthropic: ["claude-sonnet-5"], openai: [], openrouter: [] }))!;
  expect(claudeOnly.gateway).toBeUndefined();
  expect(claudeOnly.warnings).toHaveLength(2);
  expect(cloudHomeConfiguration(withModels({ anthropic: [], openai: [], openrouter: [] }))!.gateway).toBeUndefined();
});

it("never echoes a secret or token in its refusal", () => {
  for (const env of [contract({ OMB_CLOUD_BOOTSTRAP_SECRET: `${secret}!` }), { ...withModels(), OMB_HOSTED_MODEL_TOKEN: `${token}x` }]) {
    try { cloudHomeConfiguration(env); expect.unreachable(); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(token); }
  }
});

it("keeps the exclusive workspace model policy off, so personal engines stay", () => {
  expect(hostedModelPolicy(directory(), withModels())).toBeNull();
});

// ── the Admin's signed pairing request ───────────────────────────────────────

function fixture() {
  const root = directory();
  let now = 1_800_000_000_000;
  const sessions = new SessionRegistry({ file: join(root, "sessions.json"), now: () => now });
  const pairing = createCloudPairing({ secret, sessions, now: () => now });
  let counter = 0;
  const sign = (body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 }), options: { key?: string; at?: number; nonce?: string } = {}) => {
    const timestamp = String(Math.floor((options.at ?? now) / 1000)), nonce = options.nonce ?? `nonce-${String(++counter).padStart(12, "0")}`;
    return { timestamp, nonce, signature: `v1=${cloudPairingSignature(options.key ?? secret, timestamp, nonce, body)}`, body: Buffer.from(body) };
  };
  const mint = (request = sign(), source = "203.0.113.9") => pairing.handle({ ...request, source });
  const exchange = (code: string, source = "198.51.100.4") => sessions.exchange({ code, label: "", source });
  return { sessions, sign, mint, exchange, advance: (ms: number) => { now += ms; }, now: () => now };
}

it("opens one ordinary pairing window for a correctly signed request", () => {
  const f = fixture();
  const granted = f.mint();
  expect(granted.status).toBe(200);
  expect(Object.keys(granted.body).sort()).toEqual(["code", "credential", "expiresAt"]);
  expect(granted.body.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(granted.body.credential).toMatch(/^omb_pair_[A-Za-z0-9_-]{43}$/);
  expect(granted.body.expiresAt).toBe(f.now() + 300_000);
  const paired = f.exchange(granted.body.code as string);
  expect(paired).toMatchObject({ ok: true, session: { label: "OpenMausBot app (Cloud)", scopes: ["admin", "client"] } });
});

it("matches the Admin's signature byte for byte", () => {
  // printf 'v1\\n1800000000\\nnonce-fixture-0001\\nPOST\\n/api/cloud/pairing\\n<b64url sha256 of {}>' | openssl dgst -sha256 -hmac k -binary | base64url
  expect(cloudPairingSignature("k", "1800000000", "nonce-fixture-0001", "{}")).toBe("OlkaKFywjZ3VtoYxwTWpy025Itpl14gCeUrp8JYpX2o");
  expect(cloudPairingSignature("k", "1800000000", "nonce-fixture-0001", Buffer.from("{}"))).toBe("OlkaKFywjZ3VtoYxwTWpy025Itpl14gCeUrp8JYpX2o");
});

it("refuses a wrong key, a tampered request or a malformed signature, and counts each", () => {
  const f = fixture();
  const good = f.sign();
  const variants = [
    f.sign(undefined, { key: "W".repeat(43) }),
    { ...good, body: Buffer.from(JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 600 })) },
    { ...good, nonce: "nonce-tampered-000" },
    { ...good, timestamp: String(Number(good.timestamp) + 1) },
    { ...good, signature: good.signature.slice(3) },
    { ...good, signature: `v2=${good.signature.slice(3)}` },
    { ...good, signature: undefined },
    { ...good, signature: `v1=${"A".repeat(43)}` },
  ];
  for (const request of variants) expect(f.mint(request as typeof good)).toEqual({ status: 401, body: { error: "invalid_signature" } });
  expect(f.sessions.openPairings()).toHaveLength(0);
  expect(f.sessions.failureSources()).toEqual(["203.0.113.9"]);
  expect(f.mint(good).status).toBe(200);
});

it("locks out a source that keeps sending bad signatures", () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.mint(f.sign(undefined, { key: "W".repeat(43) }));
  expect(f.mint().status).toBe(429);
  expect(f.mint(f.sign(), "192.0.2.77").status).toBe(200);
});

it("accepts only a fresh timestamp", () => {
  const f = fixture();
  const skew = CLOUD_PAIRING_SKEW_S * 1000;
  expect(f.mint(f.sign(undefined, { at: f.now() - skew })).status).toBe(200);
  expect(f.mint(f.sign(undefined, { at: f.now() + skew })).status).toBe(200);
  expect(f.mint(f.sign(undefined, { at: f.now() - skew - 1000 }))).toEqual({ status: 401, body: { error: "stale_request" } });
  expect(f.mint(f.sign(undefined, { at: f.now() + skew + 1000 }))).toEqual({ status: 401, body: { error: "stale_request" } });
});

it("refuses a replayed request for as long as its timestamp could be accepted", () => {
  const f = fixture();
  const request = f.sign();
  expect(f.mint(request).status).toBe(200);
  expect(f.mint(request)).toEqual({ status: 401, body: { error: "replayed_request" } });
  expect(f.sessions.openPairings()).toHaveLength(1);
  // The same nonce, freshly signed later, is still refused within the window.
  f.advance(CLOUD_PAIRING_NONCE_MS - 1);
  expect(f.mint(f.sign(undefined, { nonce: request.nonce }))).toEqual({ status: 401, body: { error: "replayed_request" } });
  expect(f.sessions.openPairings()).toHaveLength(0);
});

it("keeps every window single use and short lived, capping what the Admin asks for", () => {
  const f = fixture();
  const granted = f.mint();
  expect(f.exchange(granted.body.code as string).ok).toBe(true);
  expect(f.exchange(granted.body.code as string).ok).toBe(false);
  expect(f.exchange(granted.body.credential as string).ok).toBe(false);
  const long = f.mint(f.sign(JSON.stringify({ ttlSeconds: 86_400 })));
  expect(long.body.expiresAt).toBe(f.now() + CLOUD_PAIRING_MAX_TTL_S * 1000);
  f.advance(CLOUD_PAIRING_MAX_TTL_S * 1000);
  expect(f.exchange(long.body.code as string).ok).toBe(false);
  const plain = f.mint(f.sign("{}"));
  expect(plain.body.expiresAt).toBe(f.now() + 300_000);
  expect(f.exchange(plain.body.code as string)).toMatchObject({ ok: true, session: { label: "OMB Cloud" } });
});

it("refuses a body that is not the expected JSON", () => {
  const f = fixture();
  for (const body of ["[]", "not json", JSON.stringify({ label: "tab\there" }), JSON.stringify({ label: "x".repeat(81) }),
    JSON.stringify({ ttlSeconds: 0 }), JSON.stringify({ ttlSeconds: 1.5 }), JSON.stringify({ ttlSeconds: "300" })]) {
    expect(f.mint(f.sign(body)).status).toBe(400);
  }
  expect(f.sessions.openPairings()).toHaveLength(0);
});

// ── the edge never makes a remote request the owner ─────────────────────────

it("treats a request the edge forwards as remote, whatever Host it claims", () => {
  const sessions = new SessionRegistry({ file: join(directory(), "sessions.json") });
  const request = (headers: Record<string, string>) => ({ method: "GET", headers, socket: { remoteAddress: "127.0.0.1", remoteFamily: "IPv4" } }) as unknown as IncomingMessage;
  const url = new URL("http://localhost/api/bots");
  // What Caddy sends upstream: the public Host plus X-Forwarded-*.
  for (const headers of [
    { host: "home-7f3k2.fly.dev", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
    { host: "localhost:8799", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
  ]) {
    const result = resolveRequestAuth(request(headers), { sessions, cookieName: "omb_session_x", streamPath: "/api/events", url });
    expect(result.auth).toBeNull();
    expect(result.status).toBe(403);
  }
});

// ── volume and launcher ──────────────────────────────────────────────────────

it("binds a fresh volume to its machine and refuses anyone else's data", () => {
  const home = directory();
  mkdirSync(join(home, "lost+found"));
  writeFileSync(join(home, ".bashrc"), "");
  expect(prepareCloudHomeVolume(home, "home-7f3k2")).toBe("new");
  expect(JSON.parse(readFileSync(join(home, CLOUD_HOME_MARKER), "utf8"))).toEqual({ version: 1, machine: "home-7f3k2" });
  expect(prepareCloudHomeVolume(home, "home-7f3k2")).toBe("existing");
  expect(() => prepareCloudHomeVolume(home, "home-other")).toThrow(/another Cloud machine/);
  const unmarked = directory();
  writeFileSync(join(unmarked, "notes.txt"), "someone's data");
  expect(() => prepareCloudHomeVolume(unmarked, "home-7f3k2")).toThrow(/Refusing to adopt/);
  expect(readFileSync(join(unmarked, "notes.txt"), "utf8")).toBe("someone's data");
});

it("gives the edge only its routing name and the server the contract", () => {
  const config = cloudHomeConfiguration(withModels())!;
  const { server, edge } = cloudHomeChildEnvironments(config, { ...withModels(), PATH: "/usr/bin" }, "/data");
  expect(server).toMatchObject({ HOME: "/data", OMB_DATA_DIR: "/data/.openmausbot", OMB_PORT: "8799", OMB_WEBHOOK_PORT: "8800",
    OMB_PUBLIC_URL: "https://omb-u-1a2b3c4d5e6f.fly.dev", OMB_WEBHOOK_PUBLIC_URL: "https://omb-u-1a2b3c4d5e6f.fly.dev", OMB_HOSTED_MODEL_TOKEN: token });
  expect(edge.OMB_CLOUD_PUBLIC_HOST).toBe(cloudHomeHost(config));
  expect(JSON.stringify(edge)).not.toContain(token);
  expect(JSON.stringify(edge)).not.toContain(secret);
  expect(passwdIds("root:x:0:0::/root:/bin/sh\nmaus:x:1001:1002::/data:/bin/bash\n", "maus")).toEqual({ uid: 1001, gid: 1002 });
  expect(passwdIds("root:x:0:0::/root:/bin/sh\n", "maus")).toBeNull();
});

it("ships an edge and a Fly template that keep the server private", () => {
  const caddy = readFileSync(join(import.meta.dirname, "../deploy/fly/Caddyfile"), "utf8");
  expect(caddy).toMatch(/^:8080 \{/m);
  const upstreams = [...caddy.matchAll(/reverse_proxy (\S+)/g)].map(match => match[1]);
  expect(new Set(upstreams)).toEqual(new Set(["127.0.0.1:8799", "127.0.0.1:8800"]));
  // every forwarded request is marked as proxied
  expect(caddy.match(/header_up X-Forwarded-For \{client_ip\}/g)).toHaveLength(upstreams.length);
  const fly = readFileSync(join(import.meta.dirname, "../deploy/fly/fly.toml"), "utf8");
  expect(fly).toMatch(/internal_port = 8080/);
  expect(fly).toMatch(/destination = "\/data"/);
  expect(fly).toMatch(/path = "\/api\/health"/);
  const env = /\[env\]([\s\S]*?)\n\[/.exec(fly)![1];
  for (const secretKey of ["OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_HOSTED_MODEL_TOKEN", "OMB_CLOUD_ADMIN_URL"]) expect(env).not.toMatch(new RegExp(`^\\s*${secretKey}\\s*=`, "m"));
});
