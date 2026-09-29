import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_SIGN_IN_FAILED, isConnected, isOwnerOrAdmin, readSessionState, reasonWorthShowing, SERVICE_TRUST_REASON, signInWithBrowserGrant, takeBrowserSignInFromLocation,
  takeInvitedEmailFromLocation, takePairingCodeFromLocation,
} from "./session";

describe("what the pair page says about why it was shown", () => {
  it("stays quiet for the ordinary no-session case and repeats anything else", () => {
    expect(reasonWorthShowing("forbidden: this request came through a proxy (pair this device to use the server remotely)")).toBeNull();
    expect(reasonWorthShowing("forbidden: loopback host required (pair this device to use the server remotely)")).toBeNull();
    expect(reasonWorthShowing("403")).toBeNull();
    expect(reasonWorthShowing(undefined)).toBeNull();
    expect(reasonWorthShowing("unauthorized: this session has expired or was revoked; pair this device again")).toMatch(/expired or was revoked/);
  });
});

describe("the invited address on a pair link", () => {
  it("prefills a valid address, drops it from the address bar, and ignores junk", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("location", { search: "?email=Ada%40Example.test&x=1", pathname: "/pair", hash: "#code=ABCD" });
    vi.stubGlobal("history", { replaceState });
    expect(takeInvitedEmailFromLocation()).toBe("ada@example.test");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair?x=1#code=ABCD");
    vi.stubGlobal("location", { search: "?email=not-an-address", pathname: "/pair", hash: "" });
    expect(takeInvitedEmailFromLocation()).toBeNull();
    vi.stubGlobal("location", { search: "", pathname: "/pair", hash: "" });
    expect(takeInvitedEmailFromLocation()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("the OMB Cloud page's \"Use in your browser\" link", () => {
  const credential = `omb_pair_${"b".repeat(43)}`;
  it("is taken off the address bar and out of history before anything renders, whatever it carries", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: `#signin=${credential}` });
    expect(takeBrowserSignInFromLocation()).toBe(credential);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    // A malformed one is still removed, and is not a code for the pair form either.
    replaceState.mockClear();
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: "#signin=ABCD-EFGH-JKLM" });
    expect(takeBrowserSignInFromLocation()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    // An ordinary pairing link is left to the pair form.
    replaceState.mockClear();
    vi.stubGlobal("location", { pathname: "/pair", search: "", hash: "#code=ABCD-EFGH-JKLM" });
    expect(takeBrowserSignInFromLocation()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(takePairingCodeFromLocation()).toBe("ABCD-EFGH-JKLM");
    vi.unstubAllGlobals();
  });

  it("is redeemed as a browser sign-in into this browser's cookie, and not at all when this browser is already connected", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const server = (session: number) => (async (path: string, init?: RequestInit) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/auth/session") return new Response(JSON.stringify({ error: "pair" }), { status: session });
      return new Response(JSON.stringify({ session: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await signInWithBrowserGrant(credential, server(401))).toEqual({ ok: true });
    expect(requests.map((r) => r.path)).toEqual(["/api/auth/session", "/api/auth/pair"]);
    expect(requests[1]?.body).toMatchObject({ code: credential, cookie: true, browser: true, attemptId: expect.any(String) });
    requests.length = 0;
    const connected = (async (path: string) => {
      requests.push({ path, body: undefined });
      return new Response(JSON.stringify({ kind: "session", id: "s", label: "Chrome on Mac", scopes: ["admin", "client"], expiresAt: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await signInWithBrowserGrant(credential, connected)).toEqual({ ok: true });
    expect(requests.map((r) => r.path)).toEqual(["/api/auth/session"]);
    // A spent or expired one says so on the pair page.
    const spent = (async () => new Response(JSON.stringify({ error: "pairing code is wrong or has expired" }), { status: 401 })) as unknown as typeof fetch;
    expect(await signInWithBrowserGrant(credential, spent)).toEqual({ ok: false, error: "pairing code is wrong or has expired" });
    expect(reasonWorthShowing(BROWSER_SIGN_IN_FAILED)).toBe(BROWSER_SIGN_IN_FAILED);
  });
});

describe("who the served UI is on its own machine", () => {
  const answer = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  it("is the owner on loopback unless the server says local requests are only a service", async () => {
    const owner = await readSessionState(answer({ kind: "loopback", scopes: ["admin", "client"] }));
    expect(owner).toEqual({ kind: "loopback" });
    expect(isOwnerOrAdmin(owner)).toBe(true);
    const service = await readSessionState(answer({ kind: "loopback", scopes: ["client"], trust: "service" }));
    expect(service).toEqual({ kind: "loopback", trust: "service" });
    expect(isOwnerOrAdmin(service)).toBe(false);
    expect(isOwnerOrAdmin({ kind: "session", id: "s", label: "l", scopes: ["client"], expiresAt: 1 })).toBe(false);
    expect(isOwnerOrAdmin({ kind: "session", id: "s", label: "l", scopes: ["admin", "client"], expiresAt: 1 })).toBe(true);
    expect(isOwnerOrAdmin(null)).toBe(false);
  });
});

describe("an SSH tunnel to a server that treats local requests as a service", () => {
  it("is not connected, so the app sends it to sign in, and says why", () => {
    expect(isConnected({ kind: "loopback" })).toBe(true);
    expect(isConnected({ kind: "loopback", trust: "service" })).toBe(false);
    expect(isConnected({ kind: "session", id: "s", label: "l", scopes: ["client"], expiresAt: 1 })).toBe(true);
    expect(isConnected({ kind: "unauthenticated", error: "pair" })).toBe(false);
    expect(isConnected(null)).toBe(false);
    expect(reasonWorthShowing(SERVICE_TRUST_REASON)).toBe(SERVICE_TRUST_REASON);
  });
});
