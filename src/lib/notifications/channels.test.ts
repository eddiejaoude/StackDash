import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  channelRequest,
  describeFailure,
  discordPayload,
  isPrivateAddress,
  newSigningSecret,
  parseChannelUrl,
  pinnedFetch,
  POST_MAX_ATTEMPTS,
  postToChannel,
  PrivateAddressError,
  repairStep,
  signWebhook,
  slackPayload,
  urlPolicyFromEnv,
  webhookPayload,
  type ChannelRequest,
  type PostDeps,
  type ResolveHost,
} from "./channels";
import type { DeliveryAlert } from "./model";
import { alertNotice, testNotice, type WorkspaceLinks } from "./notice";

// Assembled at runtime so secret scanners never see a webhook-shaped literal.
const join = (...parts: string[]): string => parts.join("");
const DISCORD_URL = join("https://discord.com/api/webhooks/", "123456789012345678/", "abcDEF123_ghi-JKL");
const SLACK_URL = join("https://hooks.slack.com/services/", "T0001/B0002/", "abcDEF123456");

const links: WorkspaceLinks = {
  alerts: "https://stackdash.test/w/abc/alerts",
  connections: "https://stackdash.test/w/abc/connections",
  timeline: "https://stackdash.test/w/abc/timeline",
};

function alert(id: string, fields: Partial<DeliveryAlert> = {}): DeliveryAlert {
  return {
    id,
    ruleId: `rule-${id}`,
    title: "Vercel bandwidth passed 90 percent of the allowance",
    message: "Vercel bandwidth is at 92 percent of the allowance (920 GB of 1,000 GB). The alert threshold is 90 percent.",
    severity: "warning",
    thresholdLabel: "90 percent",
    isEstimated: false,
    providerName: "Vercel",
    projectName: "Storefront",
    resetsAt: "2026-12-01T00:00:00.000Z",
    triggeredAt: "2026-11-05T09:00:00.000Z",
    ...fields,
  };
}

const production = { allowPrivate: false };
const local = { allowPrivate: true };

describe("parseChannelUrl", () => {
  it.each([
    ["discord", DISCORD_URL, "discord.com"],
    ["discord", join("https://canary.discord.com/api/v10/webhooks/", "1/", "token_1"), "canary.discord.com"],
    ["slack", SLACK_URL, "hooks.slack.com"],
    ["webhook", "https://hooks.example.com/stackdash?team=1", "hooks.example.com"],
  ] as const)("accepts a %s URL", (kind, url, host) => {
    expect(parseChannelUrl(kind, `  ${url}  `, production)).toEqual({ ok: true, url: new URL(url).href, host });
  });

  it.each([
    ["discord", "", "Paste the webhook URL."],
    ["discord", "not a url", "This is not a valid URL."],
    ["discord", SLACK_URL, "This is not a Discord webhook URL."],
    ["discord", DISCORD_URL.replace("https:", "http:"), "This is not a Discord webhook URL."],
    ["discord", join("https://discord.com.evil.example/api/webhooks/", "1/", "token"), "This is not a Discord webhook URL."],
    ["slack", DISCORD_URL, "This is not a Slack incoming webhook URL."],
    ["slack", "https://hooks.slack.com/workflows/T1/A1/1/abc", "This is not a Slack incoming webhook URL."],
    ["webhook", "http://hooks.example.com/stackdash", "Use an https URL."],
    ["webhook", "https://user:pass@hooks.example.com/", "Remove the user name and password from the URL."],
    ["webhook", "https://127.0.0.1/hook", "This URL points to a private network address"],
    ["webhook", "https://169.254.169.254/latest/meta-data", "This URL points to a private network address"],
    ["webhook", "https://10.1.2.3/hook", "This URL points to a private network address"],
    ["webhook", "https://[::1]/hook", "This URL points to a private network address"],
    ["webhook", "https://[fec0::1]/hook", "This URL points to a private network address"],
    ["webhook", "https://[64:ff9b::a00:1]/hook", "This URL points to a private network address"],
    ["webhook", "https://[::ffff:10.0.0.1]/hook", "This URL points to a private network address"],
    ["webhook", "https://100.64.0.1/hook", "This URL points to a private network address"],
    ["webhook", "https://0x7f.1/hook", "This URL points to a private network address"],
    ["webhook", "https://localhost/hook", "This URL points to a private network address"],
    ["webhook", "https://metadata.google.internal/hook", "This URL points to a private network address"],
    ["webhook", `https://example.com/${"a".repeat(2000)}`, "This URL is too long"],
  ] as const)("refuses a %s URL %j on a production instance", (kind, url, message) => {
    const parsed = parseChannelUrl(kind, url, production);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain(message);
      // The message never repeats what was pasted: the URL is a secret.
      if (url.length > 20) expect(parsed.message).not.toContain(url);
    }
  });

  it("allows plain http to a local receiver outside production", () => {
    expect(parseChannelUrl("webhook", "http://127.0.0.1:4010/hook", local)).toEqual({
      ok: true,
      url: "http://127.0.0.1:4010/hook",
      host: "127.0.0.1",
    });
  });

  it("drops a fragment, which is never sent anyway", () => {
    const parsed = parseChannelUrl("webhook", "https://hooks.example.com/a#part", production);
    expect(parsed.ok && parsed.url).toBe("https://hooks.example.com/a");
  });

  it.each([
    [{ NODE_ENV: "production" }, false],
    [{ NODE_ENV: "production", STACKDASH_ALLOW_PRIVATE_WEBHOOKS: "1" }, true],
    [{ NODE_ENV: "production", STACKDASH_ALLOW_PRIVATE_WEBHOOKS: "true" }, false],
    [{ NODE_ENV: "development" }, true],
  ])("reads the private host policy from %j", (env, allowPrivate) => {
    expect(urlPolicyFromEnv(env)).toEqual({ allowPrivate });
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.20.30.40",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.127.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "64:ff9b::7f00:1",
    "64:ff9b::",
    "64:ff9b:1::1",
    "2002:a00:1::1",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows the public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("discordPayload", () => {
  it("has one embed per alert with the same fields as the email, and never pings anyone", () => {
    const payload = discordPayload(alertNotice({ workspaceName: "Acme", alerts: [alert("a")], links }));
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).toBe("Alert in Acme: Vercel bandwidth passed 90 percent of the allowance");
    const embeds = payload.embeds as Array<{ title: string; description: string; fields: Array<{ name: string; value: string }> }>;
    const first = embeds[0];
    expect(first?.title).toBe("Vercel bandwidth passed 90 percent of the allowance");
    expect(first?.fields.map((field) => field.name)).toEqual(["Severity", "Threshold", "Provider", "Project", "Resets", "Triggered"]);
    expect(first?.fields.find((field) => field.name === "Project")?.value).toBe("Storefront");
    expect(embeds.at(-1)?.description).toContain(`[Open the alerts page](${links.alerts})`);
  });

  it("stays within ten embeds and says how many more there are", () => {
    const alerts = Array.from({ length: 15 }, (_, index) => alert(`a${index}`));
    const payload = discordPayload(alertNotice({ workspaceName: "Acme", alerts, links }));
    const embeds = payload.embeds as Array<{ description: string }>;
    expect(embeds).toHaveLength(10);
    // 15 alerts plus 3 "what to do" items, 9 shown.
    expect(embeds.at(-1)?.description).toContain("9 more in StackDash.");
  });

  it("clips a very long message below Discord's limits", () => {
    const payload = discordPayload(alertNotice({ workspaceName: "Acme", alerts: [alert("a", { message: "x".repeat(5000), title: "t".repeat(400) })], links }));
    const [first] = payload.embeds as Array<{ title: string; description: string }>;
    expect(first?.title.length).toBe(256);
    expect(first?.description.length).toBe(1000);
    expect(first?.description.endsWith("\u2026")).toBe(true);
  });
});

describe("slackPayload", () => {
  it("has a text fallback, a header, and a section per alert with its fields", () => {
    const payload = slackPayload(alertNotice({ workspaceName: "Acme", alerts: [alert("a")], links }));
    expect(payload.text).toBe("Alert in Acme: Vercel bandwidth passed 90 percent of the allowance");
    const blocks = payload.blocks as Array<{ type: string; text?: { text: string }; fields?: Array<{ text: string }> }>;
    expect(blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: payload.text } });
    const section = blocks.find((block) => block.fields !== undefined);
    expect(section?.fields?.map((field) => field.text)).toContain("*Project*\nStorefront");
    expect(JSON.stringify(blocks.at(-1))).toContain(`<${links.alerts}|Open the alerts page>`);
  });

  it("escapes names in mrkdwn so they cannot become Slack links or mentions", () => {
    const payload = slackPayload(alertNotice({ workspaceName: "<!channel> & co", alerts: [alert("a", { projectName: "<@U123>" })], links }));
    // The header is plain_text, which Slack never parses for mentions; everything else is mrkdwn.
    const text = JSON.stringify((payload.blocks as Array<{ type: string }>).filter((block) => block.type !== "header"));
    expect(text).toContain("&lt;!channel&gt; &amp; co");
    expect(text).toContain("&lt;@U123&gt;");
    expect(payload.text).toBe("Alert in &lt;!channel&gt; &amp; co: Vercel bandwidth passed 90 percent of the allowance");
    expect(text).not.toContain("<!channel>");
  });

  it("stays within Slack's block limit for many alerts", () => {
    const alerts = Array.from({ length: 60 }, (_, index) => alert(`a${index}`));
    const blocks = slackPayload(alertNotice({ workspaceName: "Acme", alerts, links })).blocks as unknown[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(blocks.at(-1))).toContain("43 more in StackDash.");
  });
});

describe("generic webhook", () => {
  it("carries the alerts as data", () => {
    const payload = webhookPayload(alertNotice({ workspaceName: "Acme", alerts: [alert("a")], links }), new Date("2026-11-05T09:01:00.000Z"));
    expect(payload).toMatchObject({
      type: "stackdash.alerts",
      sent_at: "2026-11-05T09:01:00.000Z",
      workspace: "Acme",
      alerts: [{ id: "a", rule_id: "rule-a", severity: "warning", provider: "Vercel", project: "Storefront", resets_at: "2026-12-01T00:00:00.000Z" }],
    });
  });

  it("signs id, timestamp, and body as Standard Webhooks describe", () => {
    const secret = newSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    const notice = testNotice("Acme", "Ops hook", links);
    const request = channelRequest("webhook", { url: "https://hooks.example.com/a", signingSecret: secret }, notice, {
      now: () => new Date("2026-11-05T09:00:00.000Z"),
      newId: () => "fixed",
    });
    expect(request.headers["webhook-id"]).toBe("msg_fixed");
    expect(request.headers["webhook-timestamp"]).toBe("1793869200");
    const expected = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
      .update(`msg_fixed.1793869200.${request.body}`)
      .digest("base64");
    expect(request.headers["webhook-signature"]).toBe(`v1,${expected}`);
    expect(signWebhook(secret, "msg_fixed", 1793869200, `${request.body} `)).not.toBe(request.headers["webhook-signature"]);
  });

  it("does not sign Discord and Slack requests", () => {
    const request = channelRequest("slack", { url: SLACK_URL }, testNotice("Acme", "Ops", links), {
      now: () => new Date(),
      newId: () => "x",
    });
    expect(request.headers["webhook-signature"]).toBeUndefined();
    expect(JSON.parse(request.body)).toHaveProperty("blocks");
  });
});

describe("postToChannel: retry", () => {
  type Reply = number | Error | { status: number; headers?: Record<string, string>; body?: string };

  function mock(replies: Reply[]): { deps: Pick<PostDeps, "fetch" | "sleep" | "random" | "policy">; calls: number; sleeps: number[] } {
    const state = { calls: 0, sleeps: [] as number[] };
    const fetchMock: PostDeps["fetch"] = async () => {
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      if (reply === undefined) throw new Error("no reply");
      if (reply instanceof Error) throw reply;
      const { status, headers, body } = typeof reply === "number" ? { status: reply, headers: undefined, body: undefined } : reply;
      return new Response(status === 204 ? null : (body ?? ""), { status, ...(headers === undefined ? {} : { headers }) });
    };
    return {
      deps: {
        fetch: fetchMock,
        sleep: async (ms) => {
          state.sleeps.push(ms);
        },
        random: () => 0.5,
        policy: production,
      },
      get calls() {
        return state.calls;
      },
      sleeps: state.sleeps,
    };
  }

  const request: ChannelRequest = { kind: "discord", url: DISCORD_URL, body: "{}", headers: {} };

  it("succeeds on the first 2xx (Discord answers 204)", async () => {
    const transport = mock([204]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: true, attempts: 1 });
    expect(transport.sleeps).toEqual([]);
  });

  it("waits for Retry-After on 429, then succeeds", async () => {
    const transport = mock([{ status: 429, headers: { "retry-after": "2" } }, 200]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: true, attempts: 2 });
    expect(transport.sleeps).toEqual([2000]);
  });

  it("reads Discord's JSON retry_after when there is no header", async () => {
    const transport = mock([{ status: 429, headers: { "content-type": "application/json" }, body: '{"retry_after":0.5}' }, 204]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: true, attempts: 2 });
    expect(transport.sleeps).toEqual([500]);
  });

  it("gives up at once, retryable later, when Retry-After is longer than a tick should wait", async () => {
    const transport = mock([{ status: 429, headers: { "retry-after": "60" } }]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: 1, retryable: true, code: "rate_limited" });
    expect(transport.calls).toBe(1);
  });

  it("backs off on 5xx and succeeds on the last try", async () => {
    const transport = mock([503, 502, 200]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: true, attempts: 3 });
    expect(transport.sleeps).toEqual([750, 1500]);
  });

  it("reports a retryable failure after the last try", async () => {
    const transport = mock([500]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: POST_MAX_ATTEMPTS, retryable: true, code: "http_500" });
    expect(transport.calls).toBe(POST_MAX_ATTEMPTS);
  });

  it("retries a network error and reports it", async () => {
    const transport = mock([new TypeError("fetch failed")]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: POST_MAX_ATTEMPTS, retryable: true, code: "network_error" });
  });

  it.each([404, 410, 403, 400])("does not retry %i: the webhook is gone or refused", async (status) => {
    const transport = mock([status]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: 1, retryable: false, code: `http_${status}` });
    expect(transport.calls).toBe(1);
  });

  it("never follows a redirect", async () => {
    const transport = mock([{ status: 302, headers: { location: "http://169.254.169.254/" } }]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: 1, retryable: false, code: "http_302" });
  });

  it("stops after one try when asked to, for a test message", async () => {
    const transport = mock([500]);
    expect(await postToChannel(request, transport.deps, { maxAttempts: 1 })).toEqual({ ok: false, attempts: 1, retryable: true, code: "http_500" });
    expect(transport.sleeps).toEqual([]);
  });

  it("does not retry a host that resolves to a private address", async () => {
    const transport = mock([new PrivateAddressError("private")]);
    expect(await postToChannel(request, transport.deps)).toEqual({ ok: false, attempts: 1, retryable: false, code: "private_address" });
    expect(transport.calls).toBe(1);
  });

  it("applies the URL rules again when sending: a private URL saved with the flag on is not posted once it is off", async () => {
    const transport = mock([204]);
    const saved: ChannelRequest = { kind: "webhook", url: "http://10.0.0.5:8080/hook", body: "{}", headers: {} };
    expect(await postToChannel(saved, { ...transport.deps, policy: local })).toEqual({ ok: true, attempts: 1 });
    expect(await postToChannel(saved, transport.deps)).toEqual({ ok: false, attempts: 0, retryable: false, code: "url_not_allowed" });
    expect(transport.calls).toBe(1);
  });
});

describe("pinnedFetch", () => {
  type Reply = { status: number; headers?: Record<string, string>; body?: string };
  const received: Array<{ method: string | undefined; headers: IncomingHttpHeaders; body: string }> = [];
  const replies: Reply[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply = replies.shift() ?? { status: 204 };
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  let port = 0;

  beforeAll(async () => {
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  });

  function resolver(table: Record<string, string[]>): { resolve: ResolveHost; lookups: string[] } {
    const lookups: string[] = [];
    return {
      lookups,
      resolve: async (hostname) => {
        lookups.push(hostname);
        return (table[hostname] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
      },
    };
  }

  const init = (body = "{}") => ({ method: "POST" as const, headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });

  it("connects to the address it resolved and checked, once, keeping the host name", async () => {
    // `.test` names never resolve in DNS, so reaching the server proves the pinned address was used.
    const dns = resolver({ "hooks.stackdash.test": ["127.0.0.1"] });
    received.length = 0;
    const response = await pinnedFetch(local, dns.resolve)(`http://hooks.stackdash.test:${port}/hook`, init('{"a":1}'));
    expect(response.status).toBe(204);
    expect(dns.lookups).toEqual(["hooks.stackdash.test"]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(received[0]?.headers.host).toBe(`hooks.stackdash.test:${port}`);
  });

  it("refuses a name with any private address on a production instance, without connecting", async () => {
    const dns = resolver({ "rebind.stackdash.test": ["8.8.8.8", "127.0.0.1"] });
    received.length = 0;
    await expect(pinnedFetch(production, dns.resolve)(`http://rebind.stackdash.test:${port}/hook`, init())).rejects.toBeInstanceOf(
      PrivateAddressError,
    );
    expect(received).toEqual([]);
  });

  it("refuses a private address literal on a production instance without resolving it", async () => {
    const dns = resolver({});
    await expect(pinnedFetch(production, dns.resolve)(`http://127.0.0.1:${port}/hook`, init())).rejects.toBeInstanceOf(PrivateAddressError);
    expect(dns.lookups).toEqual([]);
  });

  it("returns status, headers, and body, so Retry-After and Discord's JSON can be read", async () => {
    replies.push({ status: 429, headers: { "content-type": "application/json", "retry-after": "1" }, body: '{"retry_after":0.5}' });
    const response = await pinnedFetch(local, resolver({}).resolve)(`http://127.0.0.1:${port}/hook`, init());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({ retry_after: 0.5 });
  });

  it("hands a redirect back instead of following it", async () => {
    replies.push({ status: 302, headers: { location: "http://169.254.169.254/" } });
    received.length = 0;
    const response = await pinnedFetch(local, resolver({}).resolve)(`http://127.0.0.1:${port}/hook`, init());
    expect(response.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it("times out while the name is still resolving", async () => {
    const hanging: ResolveHost = () => new Promise(() => {});
    const signal = AbortSignal.timeout(20);
    await expect(pinnedFetch(local, hanging)(`http://slow.stackdash.test:${port}/hook`, { ...init(), signal })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("is retried end to end by postToChannel through the pinned address", async () => {
    replies.push({ status: 503 }, { status: 200 });
    const dns = resolver({ "hooks.stackdash.test": ["127.0.0.1"] });
    const outcome = await postToChannel(
      { kind: "webhook", url: `http://hooks.stackdash.test:${port}/hook`, body: "{}", headers: {} },
      { fetch: pinnedFetch(local, dns.resolve), sleep: async () => {}, random: () => 0.5, policy: local },
    );
    expect(outcome).toEqual({ ok: true, attempts: 2 });
    expect(dns.lookups).toEqual(["hooks.stackdash.test", "hooks.stackdash.test"]);
  });
});

describe("describeFailure", () => {
  it.each([
    ["http_404", "The webhook no longer exists, or its channel was archived"],
    ["rate_limited", "The service kept asking StackDash to slow down"],
    ["private_address", "The webhook URL leads to a private network address, which this instance does not allow"],
    ["url_not_allowed", "This instance no longer allows the webhook URL"],
    ["http_503", "The service had an error"],
    ["http_302", "The webhook URL redirects somewhere else, which StackDash does not follow"],
    ["something_else", "The service rejected the message"],
    ["secret_missing", "The webhook URL can no longer be read"],
  ])("explains %s in plain words", (code, words) => {
    expect(describeFailure(code)).toBe(words);
  });
});

describe("repairStep", () => {
  it("asks for the URL again when it can no longer be read, since a test message cannot fix that", () => {
    expect(repairStep("secret_missing", false)).toBe("Remove the channel in alert settings and add it again with its URL");
    expect(repairStep("secret_missing", true)).toBe("Remove the channel and add it again with its URL");
  });

  it("asks for a fixed webhook and a test message for every other failure", () => {
    expect(repairStep("http_404", false)).toBe("Fix the webhook, then send a test message from alert settings to turn it back on, or remove it");
    expect(repairStep("http_503", true)).toBe("Fix the webhook, then send a test message to turn it back on, or remove it");
  });
});
