import { afterEach, describe, expect, it, vi } from "vitest";

import { admitsToAdminRoute, isSuperAdminEmail, reconcileSuperAdmins, showsAdminLink, syncSuperAdminRow } from "./super-admin";

const { logError, warn, info, after, rpc } = vi.hoisted(() => ({
  logError: vi.fn(() => "ref-123"),
  warn: vi.fn(),
  info: vi.fn(),
  after: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/log/logger", () => ({ log: { warn, info }, logError }));
vi.mock("next/server", () => ({ after }));
// The service role client, reduced to the one call the mirror makes: rpc(name, args).abortSignal(signal).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: (name: string, args: unknown) => ({ abortSignal: () => rpc(name, args) }) }),
}));

const ADMINS: ReadonlySet<string> = new Set(["ops@example.com"]);
const USER_ID = "10000000-0000-4000-8000-000000000001";

afterEach(() => {
  vi.unstubAllEnvs();
  logError.mockClear();
  warn.mockClear();
  info.mockClear();
  after.mockReset();
  rpc.mockReset();
});

describe("isSuperAdminEmail", () => {
  it.each([
    ["the listed address", "ops@example.com", ADMINS, true],
    ["the listed address in another case, as GitHub may report it", "Ops@Example.COM", ADMINS, true],
    ["another address", "someone@example.com", ADMINS, false],
    ["an address that only contains the listed one", "ops@example.com.evil.test", ADMINS, false],
    ["a user with no email", null, ADMINS, false],
    ["anyone, when the list is empty", "ops@example.com", new Set<string>(), false],
  ])("%s", (_title, email, admins, expected) => {
    expect(isSuperAdminEmail(email, admins)).toBe(expected);
  });
});

describe("showsAdminLink", () => {
  it.each([
    ["the listed address", "ops@example.com,second@example.com", "second@example.com", true],
    ["the listed address in another case", "ops@example.com", "OPS@example.com", true],
    ["another address", "ops@example.com", "someone@example.com", false],
    ["a user with no email", "ops@example.com", null, false],
    ["anyone, when the list is empty", "", "ops@example.com", false],
    ["anyone, when the list is blank", " , ", "ops@example.com", false],
  ])("%s", (_title, list, email, expected) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", list);
    expect(showsAdminLink({ id: USER_ID, email })).toBe(expected);
    expect(logError).not.toHaveBeenCalled();
  });

  it("hides the link and logs the reason when the list is invalid, rather than failing the page", () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com,not-an-address");
    expect(showsAdminLink({ id: USER_ID, email: "ops@example.com" })).toBe(false);
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("admin.link_check_failed", expect.any(Error));
  });

  it.each([
    ["a listed user, so their mirror row exists", "ops@example.com,second@example.com", ["ops@example.com", "second@example.com"]],
    ["an unlisted user, so a stale row is removed", "", []],
    ["anyone when the list is invalid, which no admin page accepts either", "ops@example.com,not-an-address", []],
  ])("syncs the mirror after the response for %s", async (_title, list, listed) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", list);
    rpc.mockResolvedValue({ data: listed.length > 0, error: null });
    showsAdminLink({ id: USER_ID, email: "ops@example.com" });
    expect(rpc).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledOnce();
    const [task] = after.mock.calls[0] ?? [];
    await task();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("sync_super_admin", { p_user_id: USER_ID, p_listed_emails: listed });
  });
});

describe("syncSuperAdminRow", () => {
  it("passes the whole lowercased list and answers whether the user has a row", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(syncSuperAdminRow(USER_ID, new Set(["ops@example.com"]))).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("sync_super_admin", { p_user_id: USER_ID, p_listed_emails: ["ops@example.com"] });
  });

  it("answers false and logs, never throws, when the database refuses, so the next check tries again", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement" } });
    await expect(syncSuperAdminRow(USER_ID, ADMINS)).resolves.toBe(false);
    expect(logError).toHaveBeenCalledExactlyOnceWith("admin.mirror_sync_failed", expect.anything(), { userId: USER_ID });
  });
});

describe("reconcileSuperAdmins (boot)", () => {
  it("deletes the rows of addresses no longer listed, and says how many", async () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "Ops@Example.com, second@example.com");
    rpc.mockResolvedValue({ data: 2, error: null });
    await reconcileSuperAdmins();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("reconcile_super_admins", { p_listed_emails: ["ops@example.com", "second@example.com"] });
    expect(info).toHaveBeenCalledWith("admin.mirror_reconciled", { removed: 2, listed: 2 });
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("empties the table when the list is %s", async (_title, list) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", list);
    rpc.mockResolvedValue({ data: 0, error: null });
    await reconcileSuperAdmins();
    expect(rpc).toHaveBeenCalledWith("reconcile_super_admins", { p_listed_emails: [] });
    expect(info).not.toHaveBeenCalled();
  });

  it("treats an invalid list as empty, revoking every row, and logs why", async () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com,not-an-address");
    rpc.mockResolvedValue({ data: 1, error: null });
    await reconcileSuperAdmins();
    expect(logError).toHaveBeenCalledWith("admin.mirror_list_invalid", expect.any(Error));
    expect(rpc).toHaveBeenCalledWith("reconcile_super_admins", { p_listed_emails: [] });
  });

  it.each([
    ["the database answers an error", () => rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } })],
    ["the call itself fails", () => rpc.mockRejectedValue(new TypeError("fetch failed"))],
  ])("logs an error and never throws when %s, so the server still starts", async (_title, arrange) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com");
    arrange();
    await expect(reconcileSuperAdmins()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("admin.mirror_reconcile_failed", expect.any(Error));
  });
});

describe("admitsToAdminRoute", () => {
  it.each([
    ["admits the listed address", "ops@example.com,second@example.com", "second@example.com"],
    ["admits the listed address in another case", "ops@example.com", "OPS@example.com"],
  ])("%s, logging nothing", (_title, list, email) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", list);
    expect(admitsToAdminRoute({ id: USER_ID, email })).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    ["refuses another address", "ops@example.com", "someone@example.com"],
    ["refuses a user with no email", "ops@example.com", null],
    ["refuses anyone when the list is empty", "", "ops@example.com"],
  ])("%s and logs the refusal as the page does", (_title, list, email) => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", list);
    expect(admitsToAdminRoute({ id: USER_ID, email })).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith("admin.access_refused", { userId: USER_ID });
    expect(logError).not.toHaveBeenCalled();
  });

  it("sends an invalid list on to the page, so its error page still shows, and logs the reason", () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com,not-an-address");
    expect(admitsToAdminRoute({ id: USER_ID, email: "someone@example.com" })).toBe(true);
    expect(logError).toHaveBeenCalledExactlyOnceWith("admin.proxy_check_failed", expect.any(Error));
    expect(warn).not.toHaveBeenCalled();
  });
});
