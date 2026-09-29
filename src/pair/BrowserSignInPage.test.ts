import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { CloudOwnerLine } from "../components/CloudOwner";
import { BrowserSignInPage } from "./BrowserSignInPage";

const credential = `omb_pair_${"c".repeat(43)}`;

it("says whose Cloud a browser sign-in is for, with one Continue and no second step, and never shows the credential", () => {
  const html = renderToStaticMarkup(createElement(BrowserSignInPage, { credential, owner: "ada@example.test" }));
  expect(html).toContain("Signing in to ada@example.test’s Cloud");
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain(">Continue</button>");
  expect(html).not.toContain(credential);
  expect(html).not.toContain("omb_pair_");
  expect(html).not.toMatch(/<input|<form|role="alert"/);
});

it("names the Cloud's owner quietly in the sidebar", () => {
  const html = renderToStaticMarkup(createElement(CloudOwnerLine, { owner: "ada@example.test" }));
  expect(html).toContain("ada@example.test’s Cloud");
  expect(html).toContain('title="ada@example.test’s Cloud"');
  // Icons-only sidebar: the words stay for screen readers.
  expect(renderToStaticMarkup(createElement(CloudOwnerLine, { owner: "ada@example.test", compact: true }))).toContain('class="sr-only">ada@example.test’s Cloud');
});
