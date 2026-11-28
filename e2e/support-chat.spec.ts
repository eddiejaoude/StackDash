import { randomUUID } from "node:crypto";

import { test, type Locator, type Page } from "@playwright/test";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";

import { SUPPORT_OPERATORS_TOPIC, supportUserTopic } from "../src/lib/support/live";
import { SUPPORT_INBOX_PATH, SUPPORT_MESSAGES_PATH } from "../src/lib/support/paths";

import { E2E_OFFLINE_SUPER_ADMIN, expect, ownerTest, syntheticUserClient, viewerTest, type SyntheticUser } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { fakeEmails } from "./fixtures/fake-resend";
import { collectHydrationErrors, expectHydrated } from "./fixtures/hydration";
import { tabTo } from "./fixtures/keyboard";
import { LIVE_TIMEOUT_MS } from "./fixtures/realtime";
import {
  createSupportMember,
  drawnPng,
  expectImageLoaded,
  expectJoined,
  memberContext,
  removeSupportMember,
  spendSendLimit,
  supportDeliveries,
  supportStreamReady,
  watchSupportJoin,
  type SupportMember,
} from "./fixtures/support";
import { EVIDENCE, HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

/*
 * Support chat (#680): a signed-in user writes to the instance's super admins from the launcher or
 * the messages page, and the two sides see each other's messages without reloading.
 * playwright.config.ts lists the e2e owner as a super admin, and a second address that never signs
 * in, so operator email always has an offline recipient. Every test writes as a member of its own
 * (a new synthetic user, from a client address of its own for the rate limit), so conversations,
 * unread counts, and limits never meet another test's; the operator side is the e2e owner, whose
 * inbox lists every member's conversations, so a test finds its rows by its member's name.
 */

// Evidence (PW_PR_EVIDENCE=1): one size, London time, and no motion, so captures compare.
test.use(EVIDENCE ? { viewport: { width: 1280, height: 800 }, timezoneId: "Europe/London", reducedMotion: "reduce" } : {});

/** A named screenshot for the pull request (PW_PR_EVIDENCE=1); `fullPage` for a page taller than the viewport. */
async function capture(page: Page, name: string, fullPage = false): Promise<void> {
  if (!EVIDENCE) return;
  await page.screenshot({ path: `pr-evidence/after/${name}.png`, animations: "disabled", style: HIDE_DEV_INDICATOR, fullPage });
}

const QUESTION_SUBJECT = "How do I change where alert emails go?";
const QUESTION = `${QUESTION_SUBJECT}\nI moved teams, and the old address still gets them.`;
const FIRST_REPLY = "Open Alerts, then Alert settings, and change the address under Alert emails.";
const SECOND_REPLY = "Did that work for you?";
const FOLLOW_UP = "Yes, thank you. The new address gets them now.";

function launcher(page: Page): Locator {
  return page.getByRole("button", { name: /^Message support/ });
}

function memberConversation(scope: Page | Locator): Locator {
  return scope.getByRole("region", { name: "Conversation with support" });
}

/**
 * The inbox row of the member's conversation, found by the member's name, which starts the row's
 * name. A synthetic user name is lowercase letters, digits, and hyphens, so it matches literally.
 */
function inboxRow(page: Page, member: SupportMember): Locator {
  return page.getByRole("list", { name: "Active conversations" }).getByRole("link", { name: new RegExp(`^${member.user.userName}\\b`) });
}

/** Opens the member's launcher on their timeline and waits for the composer the panel loads on first open. */
async function openLauncher(page: Page): Promise<Locator> {
  await launcher(page).click();
  const panel = page.getByRole("dialog", { name: "Chat with support" });
  await expect(panel.getByRole("textbox", { name: "Message to support" })).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
  return panel;
}

/** The conversation's id, from the panel's link to it on the messages page. */
async function panelThreadId(panel: Locator): Promise<string> {
  const link = panel.getByRole("link", { name: "Open all messages" });
  await expect(link).toHaveAttribute("href", /\?thread=[0-9a-f-]{36}$/);
  const href = await link.getAttribute("href");
  const id = new URL(href ?? "", "http://localhost").searchParams.get("thread");
  if (id === null) throw new Error("The panel does not link to its conversation.");
  return id;
}

ownerTest.describe("support chat between a member and the support inbox", () => {
  ownerTest("a message from the launcher reaches the inbox live with its context, replies reach the member live, and each side's unread is its own", async ({
    page: operator,
    browser,
  }) => {
    // Two browsers, each waiting on Realtime several times: slower than most tests.
    ownerTest.slow();
    const member = await createSupportMember("chat");
    const name = member.user.userName;
    const context = await memberContext(browser, member);
    try {
      const memberPage = await context.newPage();
      const operatorJoin = watchSupportJoin(operator, SUPPORT_OPERATORS_TOPIC);
      const memberJoin = watchSupportJoin(memberPage, supportUserTopic(member.user.id));

      await operator.goto(SUPPORT_INBOX_PATH);
      await expect(operator.getByRole("heading", { level: 1 })).toHaveText("Support inbox");
      await expect(operator.getByRole("navigation", { name: "Conversation views" }).getByRole("link", { name: "Active" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expectJoined(operatorJoin, SUPPORT_OPERATORS_TOPIC);

      const timeline = `/w/${member.workspace.slug}/timeline`;
      await memberPage.goto(timeline);
      await expectJoined(memberJoin, supportUserTopic(member.user.id));
      await supportStreamReady();
      await expect(inboxRow(operator, member)).toHaveCount(0);

      // The member writes from the launcher and sees the message in the thread.
      const panel = await openLauncher(memberPage);
      await panel.getByRole("textbox", { name: "Message to support" }).fill(QUESTION);
      await panel.getByRole("button", { name: "Send message" }).click();
      await expect(memberConversation(panel)).toContainText(QUESTION_SUBJECT);
      await expect(memberConversation(panel).getByRole("listitem")).toHaveCount(1);
      await expect(panel.getByRole("heading", { name: QUESTION_SUBJECT })).toBeVisible();
      // Rendered in the browser only: London's zone is named as the server names it.
      await expect(memberConversation(panel).getByRole("time")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (GMT|BST)$/);
      await capture(memberPage, "launcher-open");

      // The inbox lists it without a reload: unread, and the member online.
      const row = inboxRow(operator, member);
      await expect(row).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(row).toHaveAccessibleName(/, Unread\b/);
      await expect(row).toHaveAccessibleName(/Online now/, { timeout: LIVE_TIMEOUT_MS });
      await expect(row).toContainText(QUESTION_SUBJECT);

      // Opening it shows where they wrote from, and clears the operator's unread.
      await row.click();
      await expect(operator).toHaveURL(/\/app\/admin\/inbox\?thread=[0-9a-f-]{36}$/);
      const where = operator.getByRole("region", { name: "Where they wrote from" });
      await expect(where.getByRole("link", { name: timeline, exact: true })).toHaveAttribute("href", timeline);
      await expect(where).toContainText(member.workspace.name);
      await expect(where).toContainText("Owner");
      const operatorConversation = operator.getByRole("region", { name: `Conversation with ${name}` });
      await expect(operatorConversation).toContainText(QUESTION_SUBJECT);
      await expect(inboxRow(operator, member)).not.toHaveAccessibleName(/, Unread\b/, { timeout: LIVE_TIMEOUT_MS });
      await expectNoAxeViolations(operator);

      // The reply reaches the open launcher without a reload, announced politely, and the open
      // panel reads it, so the member's badge stays clear.
      await operator.getByRole("textbox", { name: `Reply to ${name}` }).fill(FIRST_REPLY);
      await operator.getByRole("button", { name: "Send reply" }).click();
      await expect(operatorConversation.getByRole("listitem").filter({ hasText: FIRST_REPLY })).toContainText("Support team");
      // The list reads again too: the row now says who answered last.
      await expect(inboxRow(operator, member)).toContainText(`Support team: ${FIRST_REPLY}`, { timeout: LIVE_TIMEOUT_MS });
      await expect(inboxRow(operator, member)).toContainText("Replied");
      await expect(memberConversation(panel)).toContainText(FIRST_REPLY, { timeout: LIVE_TIMEOUT_MS });
      await expect(memberConversation(panel).getByRole("listitem").filter({ hasText: FIRST_REPLY })).toContainText("Support");
      await expect(memberConversation(panel).getByRole("status")).toHaveText(`New message from Support: ${FIRST_REPLY}`);
      await expect(launcher(memberPage)).toHaveAccessibleName("Message support");
      await capture(memberPage, "operator-reply-live");
      await capture(operator, "operator-inbox", true);

      // With the panel closed, the next reply raises the member's badges live. The operator, who
      // has the conversation open, has nothing unread at the same time.
      await memberPage.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(launcher(memberPage)).toBeFocused();
      await operator.getByRole("textbox", { name: `Reply to ${name}` }).fill(SECOND_REPLY);
      await operator.getByRole("button", { name: "Send reply" }).click();
      await expect(launcher(memberPage)).toHaveAccessibleName("Message support 1 unread", { timeout: LIVE_TIMEOUT_MS });
      const messagesLink = memberPage.getByRole("banner").getByRole("link", { name: /^Messages/ });
      await expect(messagesLink).toHaveAccessibleName("Messages 1 unread");
      await expect(inboxRow(operator, member)).not.toHaveAccessibleName(/, Unread\b/);

      // Opening the launcher clears the member's unread only.
      await launcher(memberPage).click();
      await expect(memberConversation(panel)).toContainText(SECOND_REPLY);
      await expect(launcher(memberPage)).toHaveAccessibleName("Message support");
      await expect(messagesLink).toHaveAccessibleName("Messages");

      // The member's answer is unread for the operator, though the member has just read the
      // conversation, until the operator opens it; the member's badge stays clear throughout.
      await operator.goto(SUPPORT_INBOX_PATH);
      await expectJoined(operatorJoin, SUPPORT_OPERATORS_TOPIC);
      await panel.getByRole("textbox", { name: "Message to support" }).fill(FOLLOW_UP);
      await panel.getByRole("button", { name: "Send message" }).click();
      await expect(memberConversation(panel)).toContainText(FOLLOW_UP);
      await expect(inboxRow(operator, member)).toHaveAccessibleName(/, Unread\b/, { timeout: LIVE_TIMEOUT_MS });
      await expect(launcher(memberPage)).toHaveAccessibleName("Message support");
      await inboxRow(operator, member).click();
      await expect(operator.getByRole("region", { name: `Conversation with ${name}` })).toContainText(FOLLOW_UP);
      await expect(inboxRow(operator, member)).not.toHaveAccessibleName(/, Unread\b/, { timeout: LIVE_TIMEOUT_MS });
      await expect(launcher(memberPage)).toHaveAccessibleName("Message support");
    } finally {
      await context.close();
      await removeSupportMember(member);
    }
  });

  ownerTest("a PNG attaches on the messages page and shows as a thumbnail to the operator, and an SVG is refused with why", async ({
    page: operator,
    browser,
  }) => {
    ownerTest.slow();
    const member = await createSupportMember("images");
    const context = await memberContext(browser, member);
    try {
      const page = await context.newPage();
      const hydrationErrors = collectHydrationErrors(page);
      await page.goto(SUPPORT_MESSAGES_PATH);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Messages");
      await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
      const picker = page.getByLabel("Attach images", { exact: true });

      await picker.setInputFiles({
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      });
      await expect(page.getByRole("alert").filter({ hasText: "diagram.svg" })).toHaveText(
        "diagram.svg is an SVG image, which can carry scripts, so it cannot be attached. Attach a PNG, JPEG, GIF, or WebP image instead.",
      );
      await expect(page.getByRole("list", { name: "Images to send" })).toHaveCount(0);

      await picker.setInputFiles({ name: "usage-chart.png", mimeType: "image/png", buffer: await drawnPng(page) });
      const staged = page.getByRole("list", { name: "Images to send" }).getByRole("listitem");
      await expect(staged).toHaveCount(1);
      await expect(staged).toContainText("usage-chart.png");
      await expect(staged).toContainText("Ready to send", { timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByRole("alert").filter({ hasText: "diagram.svg" })).toHaveCount(0);

      await page.getByRole("textbox", { name: "Your message to support" }).fill("The usage chart looks wrong since Monday.\nScreenshot attached.");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page).toHaveURL(/\/account\/messages\?thread=[0-9a-f-]{36}$/);
      const threadId = new URL(page.url()).searchParams.get("thread");
      const conversation = memberConversation(page);
      await expectImageLoaded(conversation.getByRole("img", { name: "Image 1 of 1 from You. Opens full size in a new tab." }));
      await expect(page.getByRole("list", { name: "Conversations" }).getByRole("link")).toHaveCount(1);
      await expect(page.getByRole("textbox", { name: "Your reply" })).toBeVisible();
      await expectNoAxeViolations(page);
      await capture(page, "messages-page");

      // The operator sees the same image, through a signed URL of their own.
      await operator.goto(`${SUPPORT_INBOX_PATH}?thread=${threadId}`);
      const operatorConversation = operator.getByRole("region", { name: `Conversation with ${member.user.userName}` });
      await expect(operatorConversation).toContainText("The usage chart looks wrong since Monday.");
      await expectImageLoaded(
        operatorConversation.getByRole("img", { name: `Image 1 of 1 from ${member.user.userName}. Opens full size in a new tab.` }),
      );

      // On a phone the conversation shows alone, with a way back to the list.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${SUPPORT_MESSAGES_PATH}?thread=${threadId}`);
      await expect(page.getByRole("link", { name: "Back to conversations" })).toBeVisible();
      // Server rendered, then hydrated: the time reads the same in both, with London's zone named.
      await expect(memberConversation(page).getByRole("time")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (GMT|BST)$/);
      await expect(page.getByRole("list", { name: "Conversations" })).toBeHidden();
      await expectImageLoaded(memberConversation(page).getByRole("img", { name: "Image 1 of 1 from You. Opens full size in a new tab." }));
      await expectHydrated(page);
      expect(hydrationErrors()).toEqual([]);
      await capture(page, "phone-messages");
    } finally {
      await context.close();
      await removeSupportMember(member);
    }
  });
});

test.describe("writing to support as a member", () => {
  test("opens the launcher, writes, and sends by keyboard alone, and Escape puts focus back on the button", async ({ browser }) => {
    const member = await createSupportMember("keyboard");
    const context = await memberContext(browser, member);
    try {
      const page = await context.newPage();
      await page.goto(`/w/${member.workspace.slug}/timeline`);
      await expectHydrated(page);

      const button = launcher(page);
      await expect(button).toHaveAccessibleName("Message support");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await tabTo(page, button, 80);
      await expect(button).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");

      const panel = page.getByRole("dialog", { name: "Chat with support" });
      await expect(panel).toBeFocused();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      const field = panel.getByRole("textbox", { name: "Message to support" });
      await expect(field).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(field).toHaveAccessibleDescription("Press Enter to send, or Shift and Enter for a new line.");
      await tabTo(page, field, 5);
      await page.keyboard.type("Is there a dark mode?");
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type("The dashboard is bright at night.");
      await expect(field).toHaveValue("Is there a dark mode?\nThe dashboard is bright at night.");
      await expectNoAxeViolations(page);

      await page.keyboard.press("Enter");
      await expect(memberConversation(panel)).toContainText("The dashboard is bright at night.");
      await expect(panel.getByRole("heading", { name: "Is there a dark mode?" })).toBeVisible();
      // The conversation's own composer takes focus, empty, ready for the next message.
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("");
      await expectNoAxeViolations(page);

      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(button).toBeFocused();
      await expect(button).toHaveAttribute("aria-expanded", "false");
    } finally {
      await context.close();
      await removeSupportMember(member);
    }
  });

  test("over the send limit, the composer says when sending works again and keeps the draft", async ({ browser }) => {
    const member = await createSupportMember("limit");
    const context = await memberContext(browser, member);
    try {
      const page = await context.newPage();
      await page.goto(SUPPORT_MESSAGES_PATH);
      const field = page.getByRole("textbox", { name: "Your message to support" });
      await expect(field).toBeVisible();
      await spendSendLimit(member.user.id);

      const draft = "Can I invite a second owner to my workspace?";
      await field.fill(draft);
      await page.getByRole("button", { name: "Send message" }).click();
      const refusal = page.getByRole("alert").filter({ hasText: "You have sent many messages" });
      await expect(refusal).toHaveText(
        /^You have sent many messages in a short time, so this one was not sent\. You can send again in about (a minute|\d+ minutes), at \d{2}:\d{2} London time\. Your message is still here\.$/,
      );
      await expect(field).toHaveValue(draft);
      await expect(field).toHaveAccessibleDescription(/You can send again in about/);
      await expect(page.getByText("No conversations yet. Your first message starts one.")).toBeVisible();
    } finally {
      await context.close();
      await removeSupportMember(member);
    }
  });

  test("emails a super admin who is not online about a member's message, once", async ({ browser, baseURL }) => {
    const member = await createSupportMember("email");
    const context = await memberContext(browser, member);
    try {
      const page = await context.newPage();
      const timeline = `/w/${member.workspace.slug}/timeline`;
      await page.goto(timeline);
      const panel = await openLauncher(page);
      await panel.getByRole("textbox", { name: "Message to support" }).fill("Where do I find my invoices?\nI need last month's for my accountant.");
      await panel.getByRole("button", { name: "Send message" }).click();
      await expect(memberConversation(panel)).toContainText("Where do I find my invoices?");
      const threadId = await panelThreadId(panel);

      await expect
        .poll(() => supportDeliveries(threadId, E2E_OFFLINE_SUPER_ADMIN), { timeout: LIVE_TIMEOUT_MS, message: "No email was recorded" })
        .toBe(1);
      const mail = (await fakeEmails()).filter(
        (email) => email.to.includes(E2E_OFFLINE_SUPER_ADMIN) && (email.text ?? "").includes(`From ${member.user.email}.`),
      );
      expect(mail).toHaveLength(1);
      const [email] = mail;
      expect(email?.subject).toBe("Support chat: Where do I find my invoices?");
      expect(email?.text).toContain("Where do I find my invoices?\nI need last month's for my accountant.");
      expect(email?.text).toContain(`Sent from ${timeline}.`);
      expect(email?.text).toContain(`Workspace ${member.workspace.name}, where they are owner.`);
      expect(email?.text).toContain(`Open the conversation: ${baseURL}${SUPPORT_INBOX_PATH}?thread=${threadId}`);
    } finally {
      await context.close();
      await removeSupportMember(member);
    }
  });
});

/** How Realtime answers the user's join of a private topic: SUBSCRIBED, or the refusal's status. */
async function joinAs(user: SyntheticUser, topic: string): Promise<string> {
  const supabase = syntheticUserClient(user);
  await supabase.realtime.setAuth();
  let state = "joining";
  const channel = supabase.channel(topic, { config: { private: true } }).subscribe((status) => {
    if (state === "joining") state = status;
  });
  try {
    await expect.poll(() => state, { timeout: LIVE_TIMEOUT_MS, message: `Realtime never answered the join of ${topic}` }).not.toBe("joining");
    return state;
  } finally {
    await supabase.removeChannel(channel);
    supabase.realtime.disconnect();
  }
}

test("a member joins their own support topic, and is refused the operators' topic and another member's", async () => {
  // Three Realtime clients, one after another, each connecting and authorizing its join.
  test.slow();
  const [first, second] = await Promise.all([createSupportMember("topic-a"), createSupportMember("topic-b")]);
  try {
    expect(await joinAs(first.user, supportUserTopic(first.user.id))).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);
    expect(await joinAs(first.user, SUPPORT_OPERATORS_TOPIC)).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    expect(await joinAs(first.user, supportUserTopic(second.user.id))).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
  } finally {
    await Promise.all([removeSupportMember(first), removeSupportMember(second)]);
  }
});

test("a signed-out visitor is sent to sign in from the messages page and is offered no launcher", async ({ page }) => {
  await page.goto(SUPPORT_MESSAGES_PATH);
  await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount%2Fmessages$/);
  await expect(launcher(page)).toHaveCount(0);
  await page.goto("/");
  await expect(launcher(page)).toHaveCount(0);
  const threads = await page.request.get("/api/support/threads");
  expect(threads.status()).toBe(401);
});

// Headers that would tell the inbox apart from a missing path: a proxy rewrite shows in both (#374).
const REWRITE_HEADERS = ["x-middleware-rewrite", "x-nextjs-rewritten-path"] as const;

function rewriteHeaders(headers: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(REWRITE_HEADERS.map((header) => [header, headers[header]]));
}

viewerTest("a signed-in user who is not a super admin gets the same not found for the inbox as for a missing path", async ({ page }) => {
  const response = await page.goto(SUPPORT_INBOX_PATH);
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Page not found · StackDash");
  await expect(page.getByRole("heading", { level: 1, name: "We could not find that page" })).toBeVisible();
  await expect(page.getByText("Support inbox")).toHaveCount(0);

  for (const headers of [{}, { RSC: "1" }]) {
    const inbox = await page.request.get(SUPPORT_INBOX_PATH, { headers, maxRedirects: 0 });
    const missing = await page.request.get("/app/admin/no-such-page", { headers, maxRedirects: 0 });
    expect(inbox.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(rewriteHeaders(inbox.headers())).toEqual(rewriteHeaders(missing.headers()));
    expect(await inbox.text()).not.toContain("Support inbox");
  }
  const conversation = await page.request.get(`/api/support/inbox/threads/${randomUUID()}`);
  expect(conversation.status()).toBe(404);
});

ownerTest("the inbox's own route answers even a super admin as a missing path", async ({ page }) => {
  for (const headers of [{}, { RSC: "1" }]) {
    const route = await page.request.get("/super-admin/inbox", { headers, maxRedirects: 0 });
    const missing = await page.request.get("/super-admin/no-such-page", { headers, maxRedirects: 0 });
    expect(route.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(rewriteHeaders(route.headers())).toEqual(rewriteHeaders(missing.headers()));
    expect(await route.text()).not.toContain("Support inbox");
  }
});
