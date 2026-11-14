import { describe, expect, it } from "vitest";

import { FAKE_AUTHORIZE_PATH } from "@/lib/adapters/fake";

import { handoffPage, handoffResponse } from "./handoff-page";

const APP_ORIGIN = "http://localhost:3000";

function page(authorizeUrl: string, providerName = "Vercel"): string {
  return handoffPage({ providerName, authorizeUrl: new URL(authorizeUrl), appOrigin: APP_ORIGIN });
}

describe("handoffPage", () => {
  it("refreshes to the authorize URL and links to it, with one heading", () => {
    const html = page("https://vercel.com/integrations/stackdash/new?state=abc");
    const href = "https://vercel.com/integrations/stackdash/new?state=abc";
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${href}">`);
    expect(html).toContain(`<a href="${href}">Continue to Vercel</a>`);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("<h1>Continue to Vercel</h1>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Continue to Vercel</title>");
  });

  it("escapes the URL for an attribute: ampersands, quotes, and angle brackets", () => {
    // The fragment keeps a single quote and the path keeps `&` after URL parsing, so both reach
    // the builder raw; double quotes and `<` in the query are percent-encoded by the parser.
    const html = page(`https://example.com/a&b'c/<x>?q="y"&r=<z>#'"<s>`);
    const expected = "https://example.com/a&amp;b&#39;c/%3Cx%3E?q=%22y%22&amp;r=%3Cz%3E#&#39;%22%3Cs%3E";
    expect(html).toContain(`content="0;url=${expected}"`);
    expect(html).toContain(`href="${expected}"`);
    expect(html).not.toContain("'c/");
    expect(html).not.toMatch(/<[xzs]>/);
  });

  it("escapes the provider name as text", () => {
    const html = page("https://example.com/authorize", `A & B <i>"x"</i>`);
    expect(html).toContain("<h1>Continue to A &amp; B &lt;i&gt;&quot;x&quot;&lt;/i&gt;</h1>");
    expect(html).not.toContain("<i>");
  });

  it("refuses every target that is not https, except the fake route on StackDash's own origin", () => {
    for (const url of [
      "http://vercel.com/authorize",
      "javascript:alert(1)",
      "data:text/html,hello",
      `http://evil.example${FAKE_AUTHORIZE_PATH}`,
      `${APP_ORIGIN}/api/connections/fake/callback`,
    ]) {
      expect(() => page(url), url).toThrow(/Refusing/);
    }
    expect(page(`${APP_ORIGIN}${FAKE_AUTHORIZE_PATH}?state=abc`)).toContain(
      `href="${APP_ORIGIN}${FAKE_AUTHORIZE_PATH}?state=abc"`,
    );
  });

  it("contains no script", () => {
    expect(page("https://example.com/authorize?x=<script>")).not.toMatch(/<script/i);
  });
});

describe("handoffResponse", () => {
  it("answers 200 HTML that is never cached and sends no referrer", async () => {
    const response = handoffResponse({
      providerName: "Vercel",
      authorizeUrl: new URL("https://vercel.com/authorize"),
      appOrigin: APP_ORIGIN,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain('<meta name="referrer" content="no-referrer">');
  });
});
