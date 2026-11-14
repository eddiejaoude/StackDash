import { describe, expect, it } from "vitest";

import { DEMO_SEED_TEXT } from "./history";
import { demoSummaryLines, parseDemoSeedArgs, runDemoCommand, type DemoCommand, type SeededDemo } from "./seed";
import { DEMO_USER_EMAIL } from "./workspace";

const USAGE = "Usage: npm run demo -- [--member you@example.com] [--seed <text>]";

describe("parseDemoSeedArgs", () => {
  it.each([
    ["no arguments: no members and the default seed", [], { kind: "run", memberEmails: [], seed: DEMO_SEED_TEXT }],
    ["one member", ["--member", "ada@example.com"], { kind: "run", memberEmails: ["ada@example.com"], seed: DEMO_SEED_TEXT }],
    [
      "many members and a seed, in any order",
      ["--seed", "rehearsal", "--member", "ada@example.com", "--member", "grace@example.com"],
      { kind: "run", memberEmails: ["ada@example.com", "grace@example.com"], seed: "rehearsal" },
    ],
    [
      "a member in capitals with spaces, lowercased and trimmed as auth stores it",
      ["--member", "  Ada@Example.COM "],
      { kind: "run", memberEmails: ["ada@example.com"], seed: DEMO_SEED_TEXT },
    ],
  ])("accepts %s", (_title, argv, expected) => {
    expect(parseDemoSeedArgs(argv, USAGE)).toEqual(expected);
  });

  it.each([
    ["a member that is not an email", ["--member", "ada"], /"ada" is not an email address/],
    ["an empty member", ["--member", ""], /"" is not an email address/],
    ["a bad member after a good one", ["--member", "ada@example.com", "--member", "nope"], /"nope" is not an email address/],
    ["an empty seed", ["--seed", "   "], /Give --seed some text/],
    ["--member without a value", ["--member"], /--member/],
    ["an unknown flag", ["--membr", "ada@example.com"], /--membr/],
    ["a stray value", ["ada@example.com"], /ada@example.com/],
  ])("refuses %s and ends with the usage", (_title, argv, message) => {
    const parsed = parseDemoSeedArgs(argv, USAGE);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind !== "invalid") return;
    expect(parsed.message).toMatch(message);
    expect(parsed.message.endsWith(USAGE)).toBe(true);
  });
});

const SEEDED: SeededDemo = {
  workspace: { id: "fa13065f-0000-4000-8000-000000000001", slug: "p3yanskevb" },
  connections: [
    { id: "c1", provider: "vercel" },
    { id: "c2", provider: "github" },
    { id: "c3", provider: "resend" },
  ],
  members: [],
  pagePath: "/@p3yanskevb/storefront",
};

const LINK = "http://localhost:3000/auth/confirm?token_hash=abc&type=email&next=%2Fw%2Fp3yanskevb%2Fdashboard";

describe("demoSummaryLines", () => {
  it("lists the providers, the links, the owner, and the one-time sign-in link", () => {
    const lines = demoSummaryLines(SEEDED, { origin: "http://localhost:3000", signInLink: LINK });
    expect(lines).toContain("Demo workspace ready: 90 days of simulated Vercel, GitHub, and Resend.");
    expect(lines).toContain("  Dashboard: http://localhost:3000/w/p3yanskevb/dashboard");
    expect(lines).toContain("  Public:    http://localhost:3000/@p3yanskevb/storefront (anyone can open it)");
    expect(lines).toContain(`  Owner:     ${DEMO_USER_EMAIL}`);
    expect(lines).toContain(`  ${LINK}`);
    expect(lines.some((line) => line.startsWith("  Admins:"))).toBe(false);
    expect(lines.some((line) => line.includes("GitHub."))).toBe(false);
  });

  it("names the admins, and that they can also sign in with GitHub, when there are members", () => {
    const members = [
      { email: "ada@example.com", userId: "u1" },
      { email: "grace@example.com", userId: "u2" },
    ];
    const lines = demoSummaryLines({ ...SEEDED, members }, { origin: "http://localhost:3000", signInLink: LINK });
    expect(lines).toContain("  Admins:    ada@example.com, grace@example.com");
    expect(lines).toContain("The admins can also sign in with GitHub.");
  });
});

describe("runDemoCommand", () => {
  function command(overrides: Partial<DemoCommand> = {}): { command: DemoCommand; calls: string[]; out: string[]; err: string[] } {
    const calls: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    return {
      calls,
      out,
      err,
      command: {
        label: "Demo",
        usage: USAGE,
        refusal: () => {
          calls.push("refusal");
          return null;
        },
        seed: async (input) => {
          calls.push(`seed ${input.memberEmails.join(",")} ${input.seed}`);
          return SEEDED;
        },
        signInLink: async (next) => {
          calls.push(`link ${next}`);
          return LINK;
        },
        origin: "http://localhost:3000",
        print: (line) => out.push(line),
        printError: (line) => err.push(line),
        afterSummary: async () => {
          calls.push("watch");
        },
        ...overrides,
      },
    };
  }

  it("seeds, mints the link to the dashboard, prints it, and only then starts the watch", async () => {
    const { command: demo, calls, out } = command();
    expect(await runDemoCommand(["--member", "ada@example.com", "--seed", "rehearsal"], demo)).toBe(0);
    expect(calls).toEqual(["refusal", "seed ada@example.com rehearsal", "link /w/p3yanskevb/dashboard", "watch"]);
    expect(out).toContain(`  ${LINK}`);
  });

  it("refuses with the refusal message, exit code 2, and touches nothing else", async () => {
    const { command: demo, calls, out, err } = command({
      refusal: () => "Provider simulation is off. Set STACKDASH_SIMULATE_PROVIDERS=1 in .env.local and run the command again.",
    });
    expect(await runDemoCommand([], demo)).toBe(2);
    expect(err).toEqual(["Demo refused. Provider simulation is off. Set STACKDASH_SIMULATE_PROVIDERS=1 in .env.local and run the command again."]);
    expect(calls).toEqual([]);
    expect(out).toEqual([]);
  });

  it("refuses bad arguments before the refusal check or any write", async () => {
    const { command: demo, calls, err } = command();
    expect(await runDemoCommand(["--member", "nope"], demo)).toBe(2);
    expect(err).toEqual([`"nope" is not an email address. ${USAGE}`]);
    expect(calls).toEqual([]);
  });

  it("never starts the watch or prints a link when the seed fails", async () => {
    const { command: demo, calls, out } = command({
      seed: async () => {
        throw new Error("Creating the demo workspace failed (code 23505).");
      },
    });
    await expect(runDemoCommand([], demo)).rejects.toThrow("code 23505");
    expect(calls).toEqual(["refusal"]);
    expect(out).toEqual([]);
  });

  it("never starts the watch when the link cannot be made", async () => {
    const { command: demo, calls } = command({
      signInLink: async () => {
        throw new Error("Making the sign-in link for demo@example.com failed: User not found");
      },
    });
    await expect(runDemoCommand([], demo)).rejects.toThrow("User not found");
    expect(calls).toEqual(["refusal", `seed  ${DEMO_SEED_TEXT}`]);
  });
});
