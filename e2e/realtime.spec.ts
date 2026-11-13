import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { z } from "zod";

import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_IN_FLIGHT_MS } from "../src/lib/realtime/refresh-scheduler";

import {
  createSyntheticUser,
  E2E_USERS,
  expect,
  ownerTest,
  removeSyntheticUser,
  STORAGE_STATE,
  syntheticUserClient,
  type SyntheticUser,
} from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { expectTopRowFits } from "./fixtures/header";
import {
  expectSubscribed,
  FrameSchema,
  isRenderRequest,
  LIVE_TIMEOUT_MS,
  type LiveChannel,
  SubscribedSchema,
  watchLiveChannel,
} from "./fixtures/realtime";

// Live updates (#129): a row written after the page loaded appears without a reload. Every test
// seeds its own workspaces, and the rows go in with the service role, the way a sync writes them.

// What a test reads from a postgres_changes payload: the table, the event type, and the row's
// workspace, plus its title for an activity event.
const LiveChangeSchema = z
  .object({
    data: z.object({
      table: z.string(),
      type: z.string(),
      record: z.object({ workspace_id: z.string(), title: z.string().optional() }),
    }),
  })
  .transform(({ data }) => data);

type SeededConnection = Readonly<{ workspaceId: string; connectionId: string; accountId: string }>;

/** A fake connection with one account, the parents every synced row points at. */
async function seedConnection(workspace: TestWorkspace): Promise<SeededConnection> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "Fake live connection",
      poll_interval_seconds: 3_600,
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "acct_live",
      display_name: "Live account",
      kind: "account",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { workspaceId: workspace.id, connectionId: connection.id, accountId: account.id };
}

/**
 * One synced event, dated now. Each event gets a type of its own unless `typeId` is given, so
 * events written seconds apart stay separate timeline rows instead of collapsing into a run (#253).
 */
async function insertEvent(
  seeded: SeededConnection,
  title: string,
  typeId = `fake.e2e_${randomUUID().slice(0, 8)}`,
): Promise<void> {
  const { error } = await adminClient().from("activity_events").insert({
    workspace_id: seeded.workspaceId,
    connection_id: seeded.connectionId,
    external_account_id: seeded.accountId,
    provider: "fake",
    type_id: typeId,
    severity: "info",
    title,
    occurred_at: new Date().toISOString(),
    dedupe_key: `e2e-live-${randomUUID()}`,
  });
  if (error) throw new Error(`Inserting a live event failed (code ${error.code}).`);
}

type MoneyMetric = Readonly<{ kind: "verified_spend" | "recurring_revenue"; metricKey: string; label: string }>;

const SPEND_METRIC: MoneyMetric = { kind: "verified_spend", metricKey: "fake.spend.month", label: "Spend this month" };

/** A USD money value for this month for the seeded account, dated today (spend unless told); returns the row id. */
async function insertMoneySnapshot(
  seeded: SeededConnection,
  amountMinor: number,
  metric: MoneyMetric = SPEND_METRIC,
): Promise<string> {
  const now = new Date();
  const { data, error } = await adminClient()
    .from("usage_snapshots")
    .insert({
      workspace_id: seeded.workspaceId,
      connection_id: seeded.connectionId,
      external_account_id: seeded.accountId,
      metric_key: metric.metricKey,
      kind: metric.kind,
      label: metric.label,
      snapshot_date: now.toISOString().slice(0, 10),
      amount_minor: amountMinor,
      currency: "USD",
      period_start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      period_end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
      retrieved_at: now.toISOString(),
      provenance_source: "provider_api",
    })
    .select("id")
    .single();
  if (error) throw new Error(`Inserting a live snapshot failed (code ${error.code}).`);
  return data.id;
}

/** A later sync of the same day's snapshot: an UPDATE, the way a resync rewrites today's value. */
async function updateMoneySnapshot(snapshotId: string, amountMinor: number): Promise<void> {
  const { error } = await adminClient()
    .from("usage_snapshots")
    .update({ amount_minor: amountMinor, retrieved_at: new Date().toISOString() })
    .eq("id", snapshotId);
  if (error) throw new Error(`Updating a live snapshot failed (code ${error.code}).`);
}

// The columns of a delivered activity event that the isolation test compares.
const DeliveredEventSchema = z.object({ workspace_id: z.string(), title: z.string() });

type OutsideSubscription = Readonly<{
  /** "joining" until Realtime streams the changes, then "subscribed", or the failure status. */
  state: () => string;
  /** Every inserted row delivered, in order, unparsed. */
  delivered: () => readonly unknown[];
  close: () => Promise<void>;
}>;

/**
 * Subscribes to activity event inserts as a signed-in user from outside the app, with a filter per
 * workspace id the test picks: what a hostile client can send. One channel carries every binding,
 * so Realtime delivers its changes in WAL order.
 */
async function subscribeOutsideApp(user: SyntheticUser, workspaceIds: readonly string[]): Promise<OutsideSubscription> {
  const supabase = syntheticUserClient(user);
  // Join with the user's access token, not the publishable key alone (see live-refresh.tsx).
  await supabase.realtime.setAuth();
  let state = "joining";
  const delivered: unknown[] = [];
  const channel = supabase.channel(`e2e-outside:${randomUUID()}`);
  for (const workspaceId of workspaceIds) {
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "activity_events", filter: `workspace_id=eq.${workspaceId}` },
      ({ new: row }) => delivered.push(row),
    );
  }
  channel.on("system", {}, (payload: unknown) => {
    if (SubscribedSchema.safeParse(payload).success) state = "subscribed";
  });
  channel.subscribe((status) => {
    if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
      state = status;
    }
  });
  return {
    state: () => state,
    delivered: () => delivered,
    close: async () => {
      await supabase.removeAllChannels();
    },
  };
}

type HeldRender = Readonly<{
  /** Resolves with the held request. */
  route: () => Promise<Route>;
  /** How many render requests for the path the page has sent, the held one included. */
  renders: () => number;
}>;

/**
 * Holds the next render request for `path` (a refresh, or a navigation to it) until the test
 * answers it, lets every other request through, and counts the render requests. Call before the
 * page opens.
 */
async function holdNextRender(page: Page, path: string): Promise<HeldRender> {
  const held = Promise.withResolvers<Route>();
  let renders = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (!isRenderRequest(route.request(), path)) return route.fallback();
      renders += 1;
      if (renders === 1) held.resolve(route);
      else await route.fallback();
    },
  );
  return { route: () => held.promise, renders: () => renders };
}

/** Whether the channel has delivered the activity event with this title. */
function deliveredEvent(live: LiveChannel, title: string): boolean {
  return z
    .array(LiveChangeSchema)
    .parse(live.changes())
    .some(({ table, record }) => table === "activity_events" && record.title === title);
}

ownerTest.describe("live updates", () => {
  ownerTest("shows a new timeline event without a reload and leaves the channel with the workspace", async ({ page }) => {
    const workspace = await createTestWorkspace("Live timeline");
    try {
      const seeded = await seedConnection(workspace);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expectSubscribed(live);

      const title = `Live event ${randomUUID().slice(0, 8)}`;
      await insertEvent(seeded, title);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByRole("heading", { name: "No activity yet" })).toHaveCount(0);

      // Leaving the workspace removes the subscription.
      await page.getByRole("link", { name: /^Account: / }).click();
      await expect(page).toHaveURL(/\/account$/);
      await expect.poll(live.left, { timeout: LIVE_TIMEOUT_MS }).toBe(true);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows a new dashboard snapshot without a reload", async ({ page }) => {
    const workspace = await createTestWorkspace("Live dashboard");
    try {
      const seeded = await seedConnection(workspace);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", {
        name: "Spend in USD",
      });
      await expect(usd).toHaveCount(0);
      await expectSubscribed(live);

      await insertMoneySnapshot(seeded, 4_321);

      await expect(usd).toContainText("$43.21", { timeout: LIVE_TIMEOUT_MS });
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // One refresh runs at a time (#309): a change that arrives while one runs waits for it, then
  // gets one refresh of its own.
  ownerTest("shows an event that arrives while the previous refresh is still running", async ({ page }) => {
    const workspace = await createTestWorkspace("Live single flight");
    try {
      const seeded = await seedConnection(workspace);
      const path = `/w/${workspace.slug}/timeline`;
      const heldRender = await holdNextRender(page, path);
      // The page's timers run on Playwright's clock, so the test can end the second change's
      // debounce while the first refresh is still held. The clock keeps running in real time
      // otherwise, so the first refresh's REFRESH_MAX_IN_FLIGHT_MS limit runs too, checked below.
      await page.clock.install();
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expectSubscribed(live);

      const firstTitle = `First live event ${randomUUID().slice(0, 8)}`;
      // The page's time before the first refresh can start: its in-flight limit starts later.
      const beforeFirstRefresh = await page.evaluate(() => Date.now());
      await insertEvent(seeded, firstTitle);
      const running = await heldRender.route();
      // The server renders the first refresh now, before the second event exists.
      const firstRender = await running.fetch();
      await firstRender.body();

      const secondTitle = `Second live event ${randomUUID().slice(0, 8)}`;
      await insertEvent(seeded, secondTitle);
      await expect.poll(() => deliveredEvent(live, secondTitle), { timeout: LIVE_TIMEOUT_MS }).toBe(true);
      // A round trip through the page, so it has handled the change, then its debounce ends while
      // the first refresh is still running, and another round trip for any request that sends.
      await page.evaluate(() => undefined);
      await page.clock.runFor(REFRESH_DEBOUNCE_MS);
      await page.evaluate(() => undefined);
      // A run this slow would hit the first refresh's in-flight limit, which starts the second
      // refresh on purpose; that is not the single flight breaking.
      const heldForMs = (await page.evaluate(() => Date.now())) - beforeFirstRefresh;
      expect(
        heldForMs,
        "the first refresh was held past REFRESH_MAX_IN_FLIGHT_MS, so the scheduler stopped waiting for it",
      ).toBeLessThan(REFRESH_MAX_IN_FLIGHT_MS);
      // The second change waits for the first refresh instead of rendering beside it.
      expect(heldRender.renders()).toBe(1);

      await running.fulfill({ response: firstRender });
      await expect.poll(heldRender.renders).toBe(2);
      await expect(page.getByRole("heading", { name: firstTitle, exact: true })).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByRole("heading", { name: secondTitle, exact: true })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await deleteTestWorkspace(workspace);
    }
  });

  // A navigation while a refresh is still on its way joins it: Next.js builds the navigation on the
  // refreshing router state, and React renders both in one transition. The refresh must still be
  // seen to end, or every later change would queue behind it for the rest of the visit.
  ownerTest("keeps refreshing after a navigation during a running refresh", async ({ page }) => {
    const workspace = await createTestWorkspace("Live refresh navigation");
    try {
      const seeded = await seedConnection(workspace);
      const timelinePath = `/w/${workspace.slug}/timeline`;
      const dashboardPath = `/w/${workspace.slug}/dashboard`;
      const heldRender = await holdNextRender(page, timelinePath);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(timelinePath);
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expectSubscribed(live);

      await insertEvent(seeded, `Event before navigating ${randomUUID().slice(0, 8)}`);
      const running = await heldRender.route();
      const navigating = page.waitForRequest((request) => isRenderRequest(request, dashboardPath));
      await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Dashboard" }).click();
      await navigating;
      // The navigation is on its way. It reuses the layout the refresh is still fetching, so it can
      // only land once the refresh does.
      await running.continue();
      await expect(page).toHaveURL(dashboardPath);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");

      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", {
        name: "Spend in USD",
      });
      await expect(usd).toHaveCount(0);
      await insertMoneySnapshot(seeded, 4_321);
      await expect(usd).toContainText("$43.21", { timeout: LIVE_TIMEOUT_MS });
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps a workspace's changes from non-members, by the page filter and by row level security", async ({
    page,
    browser,
  }) => {
    const [ownersOnly, viewers, outsider] = await Promise.all([
      createTestWorkspace("Live owner only"),
      createTestWorkspace("Live viewer"),
      createSyntheticUser("live-outsider"),
    ]);
    const viewerContext = await browser.newContext({ storageState: STORAGE_STATE.viewer });
    let outside: OutsideSubscription | undefined;
    try {
      // The viewer and the outsider belong to `viewers` only, so `ownersOnly` is not theirs.
      const admin = adminClient();
      const [{ error: removeError }, { error: addError }] = await Promise.all([
        admin.from("workspace_members").delete().eq("workspace_id", ownersOnly.id).eq("user_id", ownersOnly.viewerId),
        admin.from("workspace_members").insert({ workspace_id: viewers.id, user_id: outsider.id, role: "viewer" }),
      ]);
      if (removeError) throw new Error(`Removing the viewer failed (code ${removeError.code}).`);
      if (addError) throw new Error(`Adding the outsider failed (code ${addError.code}).`);
      const [ownersOnlyConnection, viewersConnection] = await Promise.all([
        seedConnection(ownersOnly),
        seedConnection(viewers),
      ]);

      const viewerPage = await viewerContext.newPage();
      const ownerLive = watchLiveChannel(page, ownersOnly.id);
      const viewerLive = watchLiveChannel(viewerPage, viewers.id);
      // The viewer's page filters on its own workspace, so it never asks for `ownersOnly`. The
      // outsider asks for `ownersOnly` by id, which the app never does: only row level security
      // stands between that subscription and the row.
      const subscription = await subscribeOutsideApp(outsider, [ownersOnly.id, viewers.id]);
      outside = subscription;
      await Promise.all([page.goto(`/w/${ownersOnly.slug}/timeline`), viewerPage.goto(`/w/${viewers.slug}/timeline`)]);
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expect(viewerPage.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await Promise.all([
        expectSubscribed(ownerLive),
        expectSubscribed(viewerLive),
        expect.poll(subscription.state, { timeout: LIVE_TIMEOUT_MS }).toBe("subscribed"),
      ]);

      const ownerOnlyTitle = `Owner only event ${randomUUID().slice(0, 8)}`;
      await insertEvent(ownersOnlyConnection, ownerOnlyTitle);
      // A member receives it, so Realtime has already decided who gets the row.
      await expect(page.getByRole("heading", { name: ownerOnlyTitle, exact: true })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });

      // Realtime delivers a channel's changes in WAL order, so once a row written after the owner
      // only row arrives on a channel, the owner only row is not still on its way to that channel.
      const sentinelTitle = `Viewer sentinel ${randomUUID().slice(0, 8)}`;
      await insertEvent(viewersConnection, sentinelTitle);
      await expect(viewerPage.getByRole("heading", { name: sentinelTitle, exact: true })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect.poll(() => subscription.delivered().length, { timeout: LIVE_TIMEOUT_MS }).toBeGreaterThan(0);

      // A non-member: nothing about `ownersOnly` reached the viewer's tab on any table, and of the
      // events, only the sentinel. The viewer is not a member of `ownersOnly`, so the page filter
      // and row level security both stand in the way here. The connection seeded for `viewers`
      // before the tab subscribed may arrive as well (#226), so the events written after
      // subscribing are what is counted, not every change the tab received.
      const viewerChanges = z.array(LiveChangeSchema).parse(viewerLive.changes());
      expect(viewerChanges.filter(({ record }) => record.workspace_id !== viewers.id)).toEqual([]);
      expect(viewerChanges.filter(({ table }) => table === "activity_events")).toEqual([
        { table: "activity_events", type: "INSERT", record: { workspace_id: viewers.id, title: sentinelTitle } },
      ]);
      await expect(viewerPage.getByRole("heading", { name: ownerOnlyTitle })).toHaveCount(0);
      // Row level security: the binding filtered on `ownersOnly` delivered nothing.
      expect(z.array(DeliveredEventSchema).parse(subscription.delivered())).toEqual([
        { workspace_id: viewers.id, title: sentinelTitle },
      ]);

      // The page filter alone: the owner is a member of both workspaces, so row level security
      // lets the sentinel through to the owner and only the `ownersOnly` filter keeps it off the
      // owner's tab. The sentinel's arrival elsewhere says nothing about the owner's socket, so an
      // `ownersOnly` row written after the sentinel is the anchor: once it arrives on the owner's
      // channel, in WAL order, the sentinel is not still on its way there.
      const anchorTitle = `Owner anchor ${randomUUID().slice(0, 8)}`;
      await insertEvent(ownersOnlyConnection, anchorTitle);
      await expect(page.getByRole("heading", { name: anchorTitle, exact: true })).toBeVisible({
        timeout: LIVE_TIMEOUT_MS,
      });
      const ownerChanges = z.array(LiveChangeSchema).parse(ownerLive.changes());
      expect(ownerChanges.filter(({ record }) => record.workspace_id !== ownersOnly.id)).toEqual([]);
      expect(ownerChanges.filter(({ table }) => table === "activity_events")).toEqual([
        { table: "activity_events", type: "INSERT", record: { workspace_id: ownersOnly.id, title: ownerOnlyTitle } },
        { table: "activity_events", type: "INSERT", record: { workspace_id: ownersOnly.id, title: anchorTitle } },
      ]);
    } finally {
      await Promise.all([viewerContext.close(), outside?.close()]);
      await Promise.all([deleteTestWorkspace(ownersOnly), deleteTestWorkspace(viewers)]);
      await removeSyntheticUser(outsider);
    }
  });
});

// Arriving data (#171): the keyframes the workspace runs when a live refresh brings new data
// (src/app/globals.css). The landing page runs some of them too, never a workspace page on load.
const ARRIVAL_ANIMATIONS: readonly string[] = [
  "feed-content-in",
  "feed-flash",
  "alert-glow",
  "count-up",
  "bar-fill",
  "spark-ping",
  "live-pulse",
];

// A highlight clears after ARRIVAL_HIGHLIGHT_MS (4 s, src/lib/realtime/arrivals.ts); this leaves
// room for a slow first render.
const HIGHLIGHT_CLEARED_MS = 10_000;

// The live indicator's dot has no fill unless the channel is live (src/components/app/arrivals.tsx).
const NO_FILL = "rgba(0, 0, 0, 0)";

// The account link's name in the header, for the top-row fit check.
const OWNER_ACCOUNT = `Account: ${E2E_USERS.owner.userName}`;

/**
 * Records the name of every arrival animation that starts on the page, from the first document
 * on, so "nothing animated" is an observed fact rather than a check that happened to run late.
 * Call before navigating.
 */
async function recordArrivalAnimations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const started: string[] = [];
    Reflect.set(window, "__startedAnimations", started);
    document.addEventListener("animationstart", (event) => started.push(event.animationName), true);
  });
  return async () => {
    const started = z.array(z.string()).parse(await page.evaluate(() => Reflect.get(window, "__startedAnimations")));
    return started.filter((name) => ARRIVAL_ANIMATIONS.includes(name));
  };
}

/** Records every sentence the polite arrival region says from now on. */
async function recordAnnouncements(page: Page): Promise<() => Promise<string[]>> {
  await page.getByTestId("arrival-announcement").evaluate((region) => {
    const said: string[] = [];
    Reflect.set(window, "__announcements", said);
    new MutationObserver(() => {
      const text = region.textContent ?? "";
      if (text !== "") said.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
  return async () => z.array(z.string()).parse(await page.evaluate(() => Reflect.get(window, "__announcements")));
}

ownerTest.describe("arriving data", () => {
  ownerTest("marks a new timeline event once, announces it, and animates nothing on load", async ({ page }) => {
    const workspace = await createTestWorkspace("Arrival timeline");
    try {
      const seeded = await seedConnection(workspace);
      await insertEvent(seeded, "Earlier event");
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("heading", { name: "Earlier event", exact: true })).toBeVisible();
      await expectSubscribed(live);
      const announcements = await recordAnnouncements(page);
      const indicator = page.getByRole("button", { name: "Live updates" });
      await expect(indicator).toBeVisible();
      // Subscribed: the name is "Live updates" with the one seeded connection, and the visible word says Live.
      await expect(indicator).toHaveAccessibleName("Live updates, 1 connected");
      await expect(indicator.getByText("Live", { exact: true })).toBeVisible();
      await expect(page.getByTestId("live-dot")).not.toHaveCSS("background-color", NO_FILL);
      await expect(page.getByTestId("live-pulse")).toHaveCount(0);
      expect(await animations()).toEqual([]);

      const title = `Arriving event ${randomUUID().slice(0, 8)}`;
      await insertEvent(seeded, title);
      const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      const label = row.getByText(/^,?\s*New$/);
      await expect(label).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByTestId("arrival-announcement")).toHaveText("1 new event.");
      await expect.poll(animations).toEqual(expect.arrayContaining(["live-pulse", "feed-content-in", "feed-flash"]));
      // The row that was already there is not marked.
      const earlier = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Earlier event" }) });
      await expect(earlier.getByText(/^,?\s*New$/)).toHaveCount(0);

      // The highlight clears on its own, and the batch was announced exactly once.
      await expect(label).toBeHidden({ timeout: HIGHLIGHT_CLEARED_MS });
      expect(await announcements()).toEqual(["1 new event."]);

      // Focus shows when data last arrived; Escape hides it.
      await indicator.focus();
      await expect(page.getByRole("tooltip")).toContainText("Data last arrived");
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toBeHidden();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks a run of identical events when one more joins it, and keeps the run open", async ({ page }) => {
    const workspace = await createTestWorkspace("Arrival run");
    try {
      const seeded = await seedConnection(workspace);
      for (let index = 0; index < 2; index += 1) await insertEvent(seeded, "Deploy succeeded", "fake.deploy.succeeded");
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/timeline`);
      const rows = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      const run = rows.filter({ has: page.getByRole("heading", { name: "Deploy succeeded", exact: true, level: 3 }) });
      await expect(rows).toHaveCount(1);
      await expect(run.getByText("2 events", { exact: true })).toBeVisible();
      await expectSubscribed(live);
      const announcements = await recordAnnouncements(page);

      // Opened by keyboard before the arrival, to show the row stays mounted when the run grows.
      await run.locator("summary").focus();
      await page.keyboard.press("Enter");
      const members = run.getByRole("list", { name: "Deploy succeeded: 2 events" });
      await expect(members.getByRole("listitem")).toHaveCount(2);

      await insertEvent(seeded, "Deploy succeeded", "fake.deploy.succeeded");
      await expect(run.getByText("3 events", { exact: true })).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      // Still one row, still open, and announced as one new event, not a new row.
      const grown = run.getByRole("list", { name: "Deploy succeeded: 3 events" });
      await expect(grown.getByRole("listitem")).toHaveCount(3);
      await expect(page.getByText("Hide the 3 events", { exact: true })).toBeVisible();
      await expect(page.getByTestId("arrival-announcement")).toHaveText("1 new event.");
      // "New" on the run's row and on the event that joined it, the newest; the others are not new.
      await expect(run.getByText(/^,?\s*New$/).first()).toBeVisible();
      await expect(grown.getByRole("listitem").first().getByText(/^,?\s*New$/)).toBeVisible();
      await expect(grown.getByRole("listitem").nth(1).getByText(/^,?\s*New$/)).toHaveCount(0);
      await expectNoAxeViolations(page);

      await expect(grown.getByRole("listitem").first().getByText(/^,?\s*New$/)).toBeHidden({
        timeout: HIGHLIGHT_CLEARED_MS,
      });
      expect(await announcements()).toEqual(["1 new event."]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says connecting until the channel joins, and offline, still retrying, when Realtime refuses it", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Live indicator states");
    try {
      // Stands in for Realtime: holds every join unanswered until `refusing`, then refuses each
      // held join and every rejoin the client schedules on its own. Heartbeats are answered so
      // the socket itself stays up.
      const held: (() => void)[] = [];
      let refusing = false;
      await page.routeWebSocket(/\/realtime\/v1\/websocket/, (socket) => {
        socket.onMessage((message) => {
          if (typeof message !== "string") return;
          const [joinRef, ref, topic, event] = FrameSchema.parse(JSON.parse(message));
          const reply = (payload: unknown) => socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", payload]));
          if (event === "heartbeat") reply({ status: "ok", response: {} });
          if (event !== "phx_join") return;
          const refuse = () => reply({ status: "error", response: { reason: "refused by the test" } });
          if (refusing) refuse();
          else held.push(refuse);
        });
      });
      await page.goto(`/w/${workspace.slug}/timeline`);
      const indicator = page.getByRole("button", { name: "Live updates" });
      const dot = page.getByTestId("live-dot");

      // Connecting: the join is unanswered, so the word, the name, and the hollow dot agree. The
      // workspace has no connections, which the name and the tooltip say as well.
      await expect(indicator).toHaveAccessibleName("Live updates, connecting, 0 connected");
      await expect(indicator.getByText("Connecting", { exact: true })).toBeVisible();
      await expect(dot).toHaveCSS("background-color", NO_FILL);
      await expect.poll(() => held.length).toBeGreaterThan(0);

      // Offline: Realtime refuses the join. The client keeps rejoining, refused each time.
      refusing = true;
      for (const refuse of held.splice(0)) refuse();
      await expect(indicator).toHaveAccessibleName("Live updates, offline, 0 connected");
      await expect(indicator.getByText("Offline", { exact: true })).toBeVisible();
      await expect(dot).toHaveCSS("background-color", NO_FILL);
      await indicator.focus();
      // Two paragraphs: the live status, then the connections (the workspace has none).
      await expect(page.getByRole("tooltip").getByRole("paragraph")).toHaveText([
        "Live updates stopped. Trying to reconnect; reload the page if this does not clear.",
        "No connections yet. Add one on the Connections page.",
      ]);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toBeHidden();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("counts, pulses, and pings a changed dashboard value, and not after a period change", async ({ page }) => {
    const workspace = await createTestWorkspace("Arrival dashboard");
    try {
      const seeded = await seedConnection(workspace);
      const snapshotId = await insertMoneySnapshot(seeded, 4_321);
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", {
        name: "Spend in USD",
      });
      await expect(usd).toContainText("$43.21");
      await expectSubscribed(live);
      expect(await animations()).toEqual([]);

      await updateMoneySnapshot(snapshotId, 5_000);
      await expect(usd).toContainText("$50.00", { timeout: LIVE_TIMEOUT_MS });
      await expect(usd.getByText("Updated", { exact: true })).toBeVisible();
      await expect(page.getByTestId("arrival-announcement")).toContainText("Spend in USD updated.");
      await expect
        .poll(animations)
        .toEqual(expect.arrayContaining(["live-pulse", "count-up", "alert-glow", "spark-ping"]));
      await expect(usd.getByText("Updated", { exact: true })).toBeHidden({ timeout: HIGHLIGHT_CLEARED_MS });

      // Changing the trend period is navigation, not arrival: nothing new animates.
      const before = (await animations()).length;
      await page.getByRole("link", { name: /^Monthly/ }).click();
      await expect(page).toHaveURL(/trend=monthly/);
      await expect(page.getByRole("link", { name: /^Monthly/ })).toHaveAttribute("aria-current", "page");
      expect(await animations()).toHaveLength(before);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("pings the newest trend point on a chart with event markers, and not after a marker toggle", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Arrival trend markers");
    try {
      const seeded = await seedConnection(workspace);
      const snapshotId = await insertMoneySnapshot(seeded, 4_321);
      await insertEvent(seeded, "Deployed before the page opened", "fake.deploy.succeeded");
      const today = new Date().toISOString().slice(0, 10);
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const trends = page.getByRole("region", { name: "Trends" });
      const spend = trends.getByRole("figure", { name: "Spend this month (Example provider, USD)" });
      const marker = spend.getByRole("link", { name: `1 deployment on ${today}` });
      await expect(marker).toBeVisible();
      await expectSubscribed(live);
      expect(await animations()).toEqual([]);

      // Markers wrap the chart in a sideways scroll frame; today's point still pings, markers kept.
      await updateMoneySnapshot(snapshotId, 5_000);
      await expect(spend.getByTestId("trend-ping")).toBeAttached({ timeout: LIVE_TIMEOUT_MS });
      await expect.poll(animations).toEqual(expect.arrayContaining(["spark-ping"]));
      await expect(marker).toBeVisible();
      await expect(spend.getByTestId("trend-ping")).toHaveCount(0, { timeout: HIGHLIGHT_CLEARED_MS });

      // Hiding a marker category is navigation, not arrival: nothing new animates.
      const before = (await animations()).length;
      await trends.getByRole("navigation", { name: "Event markers" }).getByRole("link", { name: "Hide deployments" }).click();
      await expect(page).toHaveURL(/[?&]hide_marker=deployments(&|$)/);
      await expect(marker).toHaveCount(0);
      expect(await animations()).toHaveLength(before);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks the provider card when one recurring revenue rate changes, and leaves the other rate alone", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Arrival recurring revenue");
    try {
      const seeded = await seedConnection(workspace);
      await insertMoneySnapshot(seeded, 1_000, {
        kind: "recurring_revenue",
        metricKey: "fake.mrr",
        label: "Monthly recurring revenue",
      });
      const annualId = await insertMoneySnapshot(seeded, 12_000, {
        kind: "recurring_revenue",
        metricKey: "fake.arr",
        label: "Annual recurring revenue",
      });
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const card = page.getByRole("article", { name: "Fake live connection", exact: true });
      await expect(card).toContainText("$120.00");
      await expectSubscribed(live);
      const announcements = await recordAnnouncements(page);
      expect(await animations()).toEqual([]);

      // Monthly and annual in the same currency have keys of their own, so only the annual rate counts.
      await updateMoneySnapshot(annualId, 15_000);
      await expect(card).toContainText("$150.00", { timeout: LIVE_TIMEOUT_MS });
      await expect(card.getByText("Updated", { exact: true })).toBeVisible();
      await expect.poll(announcements).toEqual([expect.stringContaining("Fake live connection updated.")]);
      await expect.poll(animations).toEqual(expect.arrayContaining(["count-up", "alert-glow"]));
      // One number counted: the annual rate. The monthly rate kept its value and did not count.
      expect((await animations()).filter((name) => name === "count-up")).toHaveLength(1);
      await expect(card).toContainText("$10.00");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("does not mark what changed while the page was out of view, on a link or a back navigation", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Arrival navigation");
    try {
      const seeded = await seedConnection(workspace);
      const snapshotId = await insertMoneySnapshot(seeded, 4_321);
      await insertEvent(seeded, "Earlier event");
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", {
        name: "Spend in USD",
      });
      const updated = usd.getByText("Updated", { exact: true });
      const nav = page.getByRole("navigation", { name: "Workspace" });
      await expect(usd).toContainText("$43.21");
      await expectSubscribed(live);
      const announcements = await recordAnnouncements(page);

      // The dashboard stays mounted but hidden while another page shows (Next.js keeps recent pages
      // in React Activity), so a sync landing meanwhile reaches it as a change in its state.
      async function syncWhileOnTimeline(amountMinor: number): Promise<void> {
        await nav.getByRole("link", { name: "Timeline" }).click();
        await expect(page).toHaveURL(/\/timeline$/);
        await expect(page.getByRole("heading", { name: "Earlier event", exact: true })).toBeVisible();
        const delivered = live.changes().length;
        const said = (await announcements()).length;
        await updateMoneySnapshot(snapshotId, amountMinor);
        // An event in the same sync shows when the timeline has refreshed past the spend change. It
        // arrives on the page in view, so it is marked and announced, including on a second visit.
        const title = `Synced while away ${randomUUID().slice(0, 8)}`;
        await insertEvent(seeded, title);
        const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
        await expect(row.getByText(/^,?\s*New$/)).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
        await expect.poll(async () => (await announcements()).slice(said)).toEqual(["1 new event."]);
        await expect.poll(() => live.changes().length).toBeGreaterThanOrEqual(delivered + 2);
      }

      /** Lets any animation the return render started fire its animationstart: two frames. */
      async function settle(): Promise<void> {
        await page.evaluate(() => {
          const { promise, resolve } = Promise.withResolvers<void>();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          return promise;
        });
      }

      // Away by link, back by link: the new value shows, unmarked and unannounced.
      await syncWhileOnTimeline(6_000);
      let startedBefore = await animations();
      let saidBefore = (await announcements()).length;
      await nav.getByRole("link", { name: "Dashboard" }).click();
      await expect(usd).toContainText("$60.00");
      await settle();
      await expect(updated).toHaveCount(0);
      expect(await animations()).toEqual(startedBefore);

      // A sync that lands while the page shows is still marked and announced, and only it is.
      await updateMoneySnapshot(snapshotId, 7_000);
      await expect(updated).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(usd).toContainText("$70.00");
      // One sentence, for this sync alone (every card showing the spend is named): the return said nothing.
      await expect
        .poll(async () => (await announcements()).slice(saidBefore))
        .toEqual([expect.stringContaining("Spend in USD updated.")]);
      await expect(updated).toBeHidden({ timeout: HIGHLIGHT_CLEARED_MS });

      // Away by link, back with the browser's back button: the same.
      await syncWhileOnTimeline(8_000);
      startedBefore = await animations();
      saidBefore = (await announcements()).length;
      await page.goBack();
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(usd).toContainText("$80.00");
      await settle();
      await expect(updated).toHaveCount(0);
      expect(await animations()).toEqual(startedBefore);
      await updateMoneySnapshot(snapshotId, 9_000);
      await expect(updated).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect
        .poll(async () => (await announcements()).slice(saidBefore))
        .toEqual([expect.stringContaining("Spend in USD updated.")]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("under reduced motion, marks a changed value with a static label and announces it once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const workspace = await createTestWorkspace("Arrival reduced motion");
    try {
      const seeded = await seedConnection(workspace);
      const snapshotId = await insertMoneySnapshot(seeded, 4_321);
      const animations = await recordArrivalAnimations(page);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", {
        name: "Spend in USD",
      });
      await expect(usd).toContainText("$43.21");
      await expectSubscribed(live);
      const announcements = await recordAnnouncements(page);
      await expect(usd.getByText("Updated", { exact: true })).toHaveCount(0);

      await updateMoneySnapshot(snapshotId, 5_000);
      await expect(usd.getByText("Updated", { exact: true })).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(usd).toContainText("$50.00");
      await expect(page.getByTestId("arrival-announcement")).toContainText("Spend in USD updated.");
      await waitForTrends(page);
      // The static highlight and its label, scanned while they show.
      await expectNoAxeViolations(page);

      // The static label clears on its own; nothing moved, scaled, or counted on the way.
      await expect(usd.getByText("Updated", { exact: true })).toBeHidden({ timeout: HIGHLIGHT_CLEARED_MS });
      expect(await animations()).toEqual([]);
      expect(await announcements()).toHaveLength(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("lists the workspace's connections, marks one needing attention, and follows a status change", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Live indicator connections");
    try {
      const { data: rows, error } = await adminClient()
        .from("connections")
        .insert(
          (
            [
              ["vercel", "active", "Acme production"],
              ["github", "needs_attention", "acme-org"],
              ["stripe", "active", "Acme billing"],
              ["resend", "revoked", "Old mailer"],
            ] as const
          ).map(([provider, status, display_name]) => ({
            workspace_id: workspace.id,
            provider,
            status,
            display_name,
            poll_interval_seconds: 3_600,
          })),
        )
        .select("id, display_name");
      if (error) throw new Error(`Seeding connections failed (code ${error.code}).`);
      const github = rows.find((row) => row.display_name === "acme-org");
      if (!github) throw new Error("The seeded GitHub connection is missing.");

      await page.setViewportSize({ width: 1280, height: 900 });
      if (process.env.PW_PR_EVIDENCE === "1") await page.emulateMedia({ reducedMotion: "reduce" });
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expectSubscribed(live);
      const indicator = page.getByRole("button", { name: /^Live updates/ });
      // The disconnected connection is neither counted nor listed; the attention mark is a shape, named too.
      await expect(indicator).toHaveAccessibleName("Live updates, 2 connected, 1 needs attention");
      await expect(indicator.getByText("2 connected", { exact: true })).toBeVisible();
      await expect(page.getByTestId("live-attention")).toBeVisible();

      await indicator.focus();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText("Connections: 2 connected, 1 needs attention.");
      const items = tooltip.getByRole("list", { name: "Connections" }).getByRole("listitem");
      // Problems first, then in the order they were connected.
      await expect(items).toHaveText([/acme-org.*Needs attention/, /Acme production.*Active/, /Acme billing.*Active/]);
      await expect(items.first().getByRole("img", { name: "GitHub" })).toBeVisible();
      await expect(tooltip).not.toContainText("Old mailer");
      await expectNoAxeViolations(page);
      if (process.env.PW_PR_EVIDENCE === "1") {
        await page.screenshot({
          path: "pr-evidence/after/live-indicator-1280.png",
          clip: { x: 480, y: 0, width: 800, height: 340 },
          animations: "disabled",
        });
      }
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();

      // Opened again by focus after leaving (Escape dismissed it until focus leaves), the tooltip
      // stays inside the viewport at this width.
      async function expectTooltipOnScreen(width: number): Promise<void> {
        await page.setViewportSize({ width, height: 800 });
        await indicator.blur();
        await indicator.focus();
        await expect(tooltip).toBeVisible();
        const box = await tooltip.boundingBox();
        if (box === null) throw new Error("The tooltip is not rendered.");
        expect(box.x, `tooltip left edge at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `tooltip right edge at ${width}px`).toBeLessThanOrEqual(width);
      }

      // With the count and the attention mark showing, the top row still fits where each appears,
      // and the tooltip stays on screen where it moves from the row to the button.
      await page.setViewportSize({ width: 1024, height: 800 });
      await expectTopRowFits(page, OWNER_ACCOUNT, { adminLink: true });
      await page.setViewportSize({ width: 640, height: 800 });
      await expectTopRowFits(page, OWNER_ACCOUNT);
      for (const width of [640, 767, 768]) await expectTooltipOnScreen(width);

      // A sync fixes the connection: the header reads the connections again on the live refresh.
      const { error: updateError } = await adminClient().from("connections").update({ status: "active" }).eq("id", github.id);
      if (updateError) throw new Error(`Updating the connection failed (code ${updateError.code}).`);
      await expect(indicator).toHaveAccessibleName("Live updates, 3 connected", { timeout: LIVE_TIMEOUT_MS });
      await expect(page.getByTestId("live-attention")).toHaveCount(0);

      // On a phone, too.
      await expectTooltipOnScreen(320);
      if (process.env.PW_PR_EVIDENCE === "1") {
        await page.screenshot({ path: "pr-evidence/after/live-indicator-320.png", clip: { x: 0, y: 0, width: 320, height: 420 } });
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
