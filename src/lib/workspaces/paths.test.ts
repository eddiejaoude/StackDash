import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALERT_SETTINGS_IDS,
  alertSettingsPath,
  isWorkspaceSlug,
  movedAlertSettingsHref,
  pathWithQuery,
  WORKSPACE_SECTIONS,
  workspaceHome,
  workspacePath,
} from "./paths";

describe("workspacePath", () => {
  it("builds /w/<slug>/<section>", () => {
    expect(workspacePath("abc123", "alerts")).toBe("/w/abc123/alerts");
  });

  // The palette and the nav link to every section, so each one needs a page in the app router.
  it.each(WORKSPACE_SECTIONS)("has a route for %s", (section) => {
    const page = path.join(process.cwd(), "src/app/w/[workspace]", section, "page.tsx");
    expect(fs.existsSync(page)).toBe(true);
  });

  it("opens a workspace on its timeline", () => {
    expect(workspaceHome("abc123")).toBe("/w/abc123/timeline");
  });
});

describe("alertSettingsPath", () => {
  it("builds the settings page under the alerts inbox, with a route behind it", () => {
    expect(alertSettingsPath("abc123")).toBe("/w/abc123/alerts/settings");
    expect(fs.existsSync(path.join(process.cwd(), "src/app/w/[workspace]/alerts/settings/page.tsx"))).toBe(true);
  });

  it("lands on a section by its fragment", () => {
    expect(alertSettingsPath("abc123", ALERT_SETTINGS_IDS.emails)).toBe("/w/abc123/alerts/settings#alert-emails");
  });
});

describe("pathWithQuery", () => {
  it("writes every value in the query's key order, then the fragment", () => {
    expect(pathWithQuery("/w/abc123/alerts/settings", { rulesAfter: "r1", budgetsAfter: "b2" }, "budgets-title")).toBe(
      "/w/abc123/alerts/settings?rulesAfter=r1&budgetsAfter=b2#budgets-title",
    );
    expect(pathWithQuery("/w/abc123/alerts", { acknowledged: "show", alertsAfter: "a2" })).toBe(
      "/w/abc123/alerts?acknowledged=show&alertsAfter=a2",
    );
  });

  it.each([
    ["every value null", { rulesAfter: null, budgetsAfter: null }, "/w/abc123/alerts/settings#budgets-title"],
    ["an empty value", { rulesAfter: "", budgetsAfter: "b1" }, "/w/abc123/alerts/settings?budgetsAfter=b1#budgets-title"],
    ["no query at all", {}, "/w/abc123/alerts/settings#budgets-title"],
  ])("leaves out %s", (_title, query, href) => {
    expect(pathWithQuery("/w/abc123/alerts/settings", query, "budgets-title")).toBe(href);
  });

  it("encodes cursor characters that would end the value, the query, or the path", () => {
    expect(pathWithQuery("/w/abc123/alerts", { alertsAfter: "a+b&c=d#e/f é" })).toBe(
      "/w/abc123/alerts?alertsAfter=a%2Bb%26c%3Dd%23e%2Ff+%C3%A9",
    );
  });

  it("adds no fragment without one", () => {
    expect(pathWithQuery("/w/abc123/alerts", { acknowledged: null, alertsAfter: null })).toBe("/w/abc123/alerts");
  });
});

describe("movedAlertSettingsHref", () => {
  // Every fragment the alerts page had for a settings section before #343, so old links still land.
  it.each(Object.values(ALERT_SETTINGS_IDS))("sends #%s on to alert settings", (id) => {
    expect(movedAlertSettingsHref("abc123", "", `#${id}`)).toBe(`/w/abc123/alerts/settings#${id}`);
  });

  it("keeps the settings pagers' cursors and drops the inbox's own query", () => {
    expect(movedAlertSettingsHref("abc123", "?rulesAfter=r1&budgetsAfter=b%2B2&acknowledged=show&alertsAfter=a1", "#budgets-title")).toBe(
      "/w/abc123/alerts/settings?rulesAfter=r1&budgetsAfter=b%2B2#budgets-title",
    );
    expect(movedAlertSettingsHref("abc123", "?rulesAfter=", "#alert-rules-title")).toBe("/w/abc123/alerts/settings#alert-rules-title");
  });

  it.each([
    ["no fragment", ""],
    ["a bare #", "#"],
    ["the inbox's own heading", "#triggered-alerts-title"],
    ["a settings id without its #", "alert-emails"],
    ["a different case", "#Alert-Emails"],
    ["a settings id with more after it", "#alert-emails-x"],
  ])("leaves %s on the inbox", (_title, hash) => {
    expect(movedAlertSettingsHref("abc123", "?rulesAfter=r1", hash)).toBeNull();
  });
});

describe("isWorkspaceSlug", () => {
  it.each(["a", "abc123", "a".repeat(64)])("accepts %s", (slug) => {
    expect(isWorkspaceSlug(slug)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["65 characters", "a".repeat(65)],
    ["capitals", "ABC123"],
    ["a path", "abc/../x"],
  ])("refuses %s", (_title, slug) => {
    expect(isWorkspaceSlug(slug)).toBe(false);
  });
});
