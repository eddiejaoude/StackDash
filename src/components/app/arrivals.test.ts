import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LIVE_CONNECTIONS_LISTED, summarizeLiveConnections, type LiveConnectionsRead } from "@/lib/realtime/arrivals";

import { LiveIndicator } from "./arrivals";

/** The tooltip's text, tags stripped, as a server render shows it (the live status is "connecting" there). */
function tooltipText(connections: LiveConnectionsRead): string {
  const markup = renderToStaticMarkup(createElement(LiveIndicator, { connections }));
  const tooltip = /<div role="tooltip"[^>]*>([\s\S]*)<\/div><\/div>$/.exec(markup)?.[1];
  if (tooltip === undefined) throw new Error("The indicator rendered no tooltip.");
  return tooltip.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** The button's accessible name: its screen reader only text. */
function buttonName(connections: LiveConnectionsRead): string | undefined {
  const markup = renderToStaticMarkup(createElement(LiveIndicator, { connections }));
  return /<span class="sr-only">([^<]*)<\/span>/.exec(markup)?.[1];
}

describe("LiveIndicator connections", () => {
  it("says the connections are loading while the read streams in, and names no count", () => {
    expect(tooltipText({ state: "loading" })).toContain("Loading connections.");
    expect(buttonName({ state: "loading" })).toBe("Live updates, connecting");
  });

  it("gives the log reference when the read failed, and keeps the live status", () => {
    const text = tooltipText({ state: "failed", reference: "ref_abc123" });
    expect(text).toContain("Connecting to live updates.");
    expect(text).toContain("Connections could not be loaded. Reload the page to try again, and quote reference ref_abc123");
    expect(buttonName({ state: "failed", reference: "ref_abc123" })).toBe("Live updates, connecting");
  });

  it("counts the connections past the cap rather than listing them", () => {
    const connections = Array.from({ length: LIVE_CONNECTIONS_LISTED + 2 }, (_, index) => ({
      id: String(index),
      provider: "vercel" as const,
      display_name: `Project ${index}`,
      status: "active" as const,
    }));
    const text = tooltipText({ state: "loaded", summary: summarizeLiveConnections(connections) });
    expect(text).toContain(`Project ${LIVE_CONNECTIONS_LISTED - 1}`);
    expect(text).not.toContain(`Project ${LIVE_CONNECTIONS_LISTED}`);
    expect(text).toContain("And 2 more on the Connections page.");
  });

  it("names the count and the connections needing attention", () => {
    const summary = summarizeLiveConnections([
      { id: "a", provider: "github", display_name: "acme-org", status: "failed" },
      { id: "b", provider: "vercel", display_name: "Acme production", status: "active" },
    ]);
    expect(buttonName({ state: "loaded", summary })).toBe("Live updates, connecting, 1 connected, 1 needs attention");
  });
});
