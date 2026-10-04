import { describe, expect, it } from "vitest";

import { appendFactoryDeskLink, FACTORY_DESK_HTML, FACTORY_DESK_PATH } from "./factory-desk-page.ts";

describe("factory desk page", () => {
  it("links the desk from the packaged index without rewriting it twice", () => {
    const once = appendFactoryDeskLink("<!doctype html><title>Packaged OpenMausBot</title></body>");
    expect(once).toContain(FACTORY_DESK_PATH);
    expect(once).toContain("data-factory-desk=\"1\"");
    expect(once).toContain("</body>");
    expect(appendFactoryDeskLink(once)).toBe(once);
  });

  it("keeps create and advance actions as browser fetches to /api/factory", () => {
    expect(FACTORY_DESK_HTML).toContain('fetch("/api/factory/tasks"');
    expect(FACTORY_DESK_HTML).toContain('POST", "/api/factory/tasks"');
    expect(FACTORY_DESK_HTML).toContain("/launch");
    expect(FACTORY_DESK_HTML).toContain("/harvest");
    expect(FACTORY_DESK_HTML).not.toContain("x-openmausbot-desktop-owner");
    expect(FACTORY_DESK_HTML).not.toContain("bypassPermissions");
    expect(FACTORY_DESK_HTML).toContain("claude-opus-5-5");
    expect(FACTORY_DESK_HTML).toContain('permissions: "auto"');
    expect(FACTORY_DESK_HTML).toContain('id="headSha"');
    expect(FACTORY_DESK_HTML).toContain('id="prUrl"');
    expect(FACTORY_DESK_HTML).toContain('id="handoffId"');
    expect(FACTORY_DESK_HTML).toContain("body.headSha = headSha");
    expect(FACTORY_DESK_HTML).toContain("body.prUrl = prUrl");
    expect(FACTORY_DESK_HTML).toContain("handoffId");
    expect(FACTORY_DESK_HTML).toContain('"/deliver"');
  });
});
