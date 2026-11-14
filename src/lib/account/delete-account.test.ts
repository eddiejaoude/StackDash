import { describe, expect, it } from "vitest";

import {
  accountDeletedPath,
  blockedMessage,
  canDeleteAccount,
  confirmationMatches,
  parseDeletionOutcome,
  planAccountDeletion,
  type MembershipFacts,
} from "@/lib/account/delete-account";

function membership(overrides: Partial<MembershipFacts> & Pick<MembershipFacts, "workspaceId">): MembershipFacts {
  return {
    slug: overrides.workspaceId,
    name: `Workspace ${overrides.workspaceId}`,
    isPersonal: false,
    role: "owner",
    memberCount: 1,
    ownerCount: 1,
    ...overrides,
  };
}

describe("planAccountDeletion", () => {
  it("deletes a workspace where the user is the only member", () => {
    const personal = membership({ workspaceId: "personal", isPersonal: true });
    const plan = planAccountDeletion([personal]);
    expect(plan).toEqual({ deletable: [personal], blocked: [], leaving: [] });
    expect(canDeleteAccount(plan)).toBe(true);
  });

  it("blocks when the user is the only owner of a workspace with other members", () => {
    const shared = membership({ workspaceId: "shared", memberCount: 2, ownerCount: 1 });
    const plan = planAccountDeletion([membership({ workspaceId: "personal" }), shared]);
    expect(plan.blocked).toEqual([shared]);
    expect(plan.deletable.map((item) => item.workspaceId)).toEqual(["personal"]);
    expect(canDeleteAccount(plan)).toBe(false);
  });

  it("leaves a workspace where another owner remains", () => {
    const coOwned = membership({ workspaceId: "co", memberCount: 3, ownerCount: 2 });
    const plan = planAccountDeletion([coOwned]);
    expect(plan).toEqual({ deletable: [], blocked: [], leaving: [coOwned] });
    expect(canDeleteAccount(plan)).toBe(true);
  });

  it.each(["admin", "viewer"] as const)("leaves a workspace where the user is an %s", (role) => {
    const other = membership({ workspaceId: "other", role, memberCount: 2, ownerCount: 1 });
    expect(planAccountDeletion([other]).leaving).toEqual([other]);
  });

  it("deletes a sole-member workspace whatever the role says", () => {
    const solo = membership({ workspaceId: "solo", role: "admin", ownerCount: 0 });
    expect(planAccountDeletion([solo]).deletable).toEqual([solo]);
  });

  it("plans nothing for no memberships", () => {
    expect(planAccountDeletion([])).toEqual({ deletable: [], blocked: [], leaving: [] });
  });
});

describe("blockedMessage", () => {
  it("names the workspace and asks for a transfer or deletion first", () => {
    expect(blockedMessage(["Team"])).toBe(
      "You are the only owner of Team, and other people belong to it. Transfer ownership to another member or delete that workspace first, then try again.",
    );
  });

  it("lists several workspaces", () => {
    expect(blockedMessage(["A", "B"])).toContain("only owner of A, B, and other people belong to them");
  });
});

describe("confirmationMatches", () => {
  const identity = { email: "Ada@Example.com", userName: "ada-dev" };

  it.each(["ada@example.com", "  ADA@EXAMPLE.COM ", "ada-dev", "Ada-Dev"])("accepts %j", (input) => {
    expect(confirmationMatches(input, identity)).toBe(true);
  });

  it.each(["", "   ", "ada", "ada@example.org", "delete"])("rejects %j", (input) => {
    expect(confirmationMatches(input, identity)).toBe(false);
  });

  it("never matches a missing identity value", () => {
    expect(confirmationMatches("", { email: null, userName: null })).toBe(false);
    expect(confirmationMatches("null", { email: null, userName: "" })).toBe(false);
  });
});

describe("deletion outcome in the redirect", () => {
  it("round trips providers and reference ids", () => {
    const outcome = {
      manual: ["vercel", "stripe", "vercel"] as const,
      failed: [{ provider: "resend" as const, referenceId: "REF-ABCDEFGH" }],
    };
    const url = new URL(accountDeletedPath(outcome), "https://stackdash.invalid");
    expect(url.pathname).toBe("/account/deleted");
    expect(parseDeletionOutcome(Object.fromEntries(url.searchParams))).toEqual({
      manual: ["vercel", "stripe"],
      failed: [{ provider: "resend", referenceId: "REF-ABCDEFGH" }],
    });
  });

  it("has no query when nothing is left to do", () => {
    expect(accountDeletedPath({ manual: [], failed: [] })).toBe("/account/deleted");
    expect(parseDeletionOutcome({})).toEqual({ manual: [], failed: [] });
  });

  it("drops unknown providers and malformed reference ids", () => {
    expect(
      parseDeletionOutcome({
        manual: "vercel,evil,<script>",
        failed: "resend:REF-ABCDEFGH,resend:not-a-ref,nobody:REF-ABCDEFGH",
      }),
    ).toEqual({ manual: ["vercel"], failed: [{ provider: "resend", referenceId: "REF-ABCDEFGH" }] });
  });
});
