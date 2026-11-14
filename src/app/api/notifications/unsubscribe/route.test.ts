import { randomBytes } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unsubscribeToken } from "@/lib/notifications/unsubscribe";

const { unsubscribeMember } = vi.hoisted(() => ({ unsubscribeMember: vi.fn() }));
vi.mock("@/lib/data/notification-preferences", () => ({ unsubscribeMember }));

import { GET, POST } from "./route";

const ORIGIN = "http://localhost:3000";
const WORKSPACE_ID = "6f1c2c7e-6a43-4c7b-9a39-0d6f0b1d2a11";
const USER_ID = "0b8f3a4e-5d2c-4e1f-8a7b-9c6d5e4f3a21";
const FORM = "application/x-www-form-urlencoded";

function oneClickRequest(token: string | null, body: BodyInit | null, contentType: string | null = FORM): NextRequest {
  const url = new URL("/api/notifications/unsubscribe", ORIGIN);
  if (token !== null) url.searchParams.set("token", token);
  const headers = new Headers();
  if (contentType !== null) headers.set("Content-Type", contentType);
  return new NextRequest(url, { method: "POST", body, headers });
}

beforeEach(() => {
  // A key generated per run, so no key material is committed.
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", "");
  unsubscribeMember.mockReset();
  unsubscribeMember.mockResolvedValue("unsubscribed");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/notifications/unsubscribe (RFC 8058)", () => {
  it("turns alert email off for the member the token names and answers 200 without a redirect", async () => {
    const response = await POST(oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), "List-Unsubscribe=One-Click"));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(unsubscribeMember).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  });

  it("accepts the field in a multipart body", async () => {
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const response = await POST(oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), form, null));
    expect(response.status).toBe(200);
    expect(unsubscribeMember).toHaveBeenCalledOnce();
  });

  it("answers 200 when the member has already left the workspace", async () => {
    unsubscribeMember.mockResolvedValue("not_member");
    const response = await POST(oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), "List-Unsubscribe=One-Click"));
    expect(response.status).toBe(200);
  });

  it.each([
    ["no token", null],
    ["an empty token", ""],
    ["a token for another member", `${WORKSPACE_ID}.9e7d6c5b-4a39-4281-b7a6-5f4e3d2c1b09.deadbeef.forged`],
  ])("refuses %s with 400 and changes nothing", async (_title, token) => {
    const response = await POST(oneClickRequest(token, "List-Unsubscribe=One-Click"));
    expect(response.status).toBe(400);
    expect(unsubscribeMember).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", ""],
    ["another value", "List-Unsubscribe=Yes"],
    ["another field", "unsubscribe=One-Click"],
  ])("refuses %s with 400", async (_title, body) => {
    const response = await POST(oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), body));
    expect(response.status).toBe(400);
    expect(unsubscribeMember).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a form with 400", async () => {
    const response = await POST(
      oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), JSON.stringify({ "List-Unsubscribe": "One-Click" }), "application/json"),
    );
    expect(response.status).toBe(400);
    expect(unsubscribeMember).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly 4096 bytes and refuses one byte more with 413", async () => {
    const field = "List-Unsubscribe=One-Click&pad=";
    const atLimit = `${field}${"a".repeat(4096 - field.length)}`;
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    expect((await POST(oneClickRequest(token, atLimit))).status).toBe(200);
    expect((await POST(oneClickRequest(token, `${atLimit}a`))).status).toBe(413);
    expect(unsubscribeMember).toHaveBeenCalledOnce();
  });

  it("answers 500 with a reference id when the write fails", async () => {
    // logError writes the detail to stderr; keep the test output clean.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    unsubscribeMember.mockRejectedValue(new Error("notification_preferences unsubscribe failed (code 08006)."));
    const response = await POST(oneClickRequest(unsubscribeToken(WORKSPACE_ID, USER_ID), "List-Unsubscribe=One-Click"));
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/Reference REF-[0-9A-Z]{8}\.$/);
  });
});

describe("GET /api/notifications/unsubscribe", () => {
  it("sends a browser to the unsubscribe page with the token, without unsubscribing", () => {
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    const url = new URL("/api/notifications/unsubscribe", ORIGIN);
    url.searchParams.set("token", token);
    const response = GET(new NextRequest(url));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${ORIGIN}/unsubscribe`);
    expect(location.searchParams.get("token")).toBe(token);
    expect(unsubscribeMember).not.toHaveBeenCalled();
  });

  it("drops a token that does not verify", () => {
    const url = new URL("/api/notifications/unsubscribe?token=not-a-token", ORIGIN);
    const location = new URL(GET(new NextRequest(url)).headers.get("location") ?? "");
    expect(location.pathname).toBe("/unsubscribe");
    expect(location.search).toBe("");
  });
});
