import type { Database } from "../src/lib/supabase/database.types";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";
import { z } from "zod";

import { openCreateForm } from "./fixtures/alerts";
import { E2E_USERS, expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { fakeEmails } from "./fixtures/fake-resend";
import { deliveredEvent, expectSubscribed, LIVE_TIMEOUT_MS, watchLiveChannel } from "./fixtures/realtime";
import { startReceiver, stopReceiver } from "./fixtures/webhook-receiver";
import { tick } from "./fixtures/webhook-ticks";

/*
 * `npm run demo:event` (#256), end to end: with the timeline open, the command makes a failed
 * deployment and a budget crossing happen in a workspace with a simulated Vercel connection, both
 * arrive without a reload, and the next tick emails the alert to the fake Resend API and posts it
 * to a webhook channel. With simulation off it refuses and writes nothing.
 *
 * The command targets this spec's own workspace with `--workspace`, never the demo workspace a
 * person may be presenting from. Delivery runs the job tick, which is instance-wide, so this spec
 * lives in the `instance-wide` Playwright project (playwright.config.ts). The other worker's
 * instance-wide specs tick while it runs, so it settles its workspace before counting anything
 * (`settleWorkspace`).
 */

const run = promisify(execFile);
const FAILED_DEPLOYMENT = "Production deployment of web failed";
// What a run of failed deployments with different titles is headed (#253, event-list.tsx).
const FAILED_DEPLOYMENTS_RUN = "Deployment failed";
const BUDGET_ALERT = "Budget Vercel monthly passed 90 percent";
// The command's deployment uid starts `dpl_simevent` (vercelFailedDeployment); the sync's never do.
const INCIDENT_DEDUPE_KEY_PREFIX = "vercel:dpl_simevent";
// A day: the command's own syncs schedule the next one this far out, so no tick syncs the
// connection while the spec runs.
const COMMAND_ONLY_POLL_INTERVAL_SECONDS = 86_400;

const FAILED_RUN = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });

/** Runs the command against this workspace; `simulate` is the flag the command reads. */
async function demoEvent(type: string, workspace: TestWorkspace, simulate = "1"): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("npm", ["run", "-s", "demo:event", "--", "--type", type, "--workspace", workspace.slug], {
      env: { ...process.env, STACKDASH_SIMULATE_PROVIDERS: simulate },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // execFile rejects on a non-zero exit, with the exit code and both streams on the error.
    const failed = FAILED_RUN.safeParse(error);
    if (!failed.success) throw error;
    return failed.data;
  }
}

/** A Vercel budget of $600 with an alert at 90 percent, as the demo seed adds. */
async function seedBudgetAlert(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { data: budget, error } = await admin
    .from("budgets")
    .insert({ workspace_id: workspace.id, name: "Vercel monthly", scope: "provider", provider: "vercel", amount_minor: 60_000, currency: "USD" })
    .select("id")
    .single();
  if (error) throw new Error(`Seeding the budget failed (code ${error.code}).`);
  const { error: ruleError } = await admin
    .from("alert_rules")
    .insert({ workspace_id: workspace.id, kind: "budget_percent", scope: "provider", provider: "vercel", budget_id: budget.id, threshold_percent: 90 });
  if (ruleError) throw new Error(`Seeding the budget alert failed (code ${ruleError.code}).`);
}

async function countEvents(workspace: TestWorkspace): Promise<number | null> {
  const { count, error } = await adminClient().from("activity_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspace.id);
  if (error) throw new Error(`Reading the events failed (code ${error.code}).`);
  return count;
}

type Incident = Pick<Database["public"]["Tables"]["activity_events"]["Row"], "id" | "title" | "occurred_at" | "connection_id" | "external_account_id">;

/** The newest failed deployment the command wrote, told apart from the sync's by its dedupe key. */
async function latestIncident(workspace: TestWorkspace): Promise<Incident> {
  const { data: incident, error } = await adminClient()
    .from("activity_events")
    .select("id, title, occurred_at, connection_id, external_account_id")
    .eq("workspace_id", workspace.id)
    .like("dedupe_key", `${INCIDENT_DEDUPE_KEY_PREFIX}%`)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw new Error(`Reading the incident failed (code ${error.code}).`);
  expect(incident.title).toBe(FAILED_DEPLOYMENT);
  return incident;
}

/**
 * A failed production deployment of `api` a millisecond before `incident`, as the command's sync
 * writes now and then (#576). It shares the incident's provider, type, severity, and account, so
 * the timeline groups the two into one run headed by the type name rather than the incident's
 * title. A millisecond leaves no room for another sync deployment to land between them.
 */
async function seedSyncFailureBefore(workspace: TestWorkspace, incident: Incident): Promise<void> {
  const { error } = await adminClient().from("activity_events").insert({
    workspace_id: workspace.id,
    connection_id: incident.connection_id,
    external_account_id: incident.external_account_id,
    provider: "vercel",
    type_id: "vercel.deployment.failed",
    severity: "critical",
    title: "Production deployment of api failed",
    occurred_at: new Date(Date.parse(incident.occurred_at) - 1).toISOString(),
    dedupe_key: "e2e-demo-event-api-failed",
  });
  if (error) throw new Error(`Seeding the sync's failed deployment failed (code ${error.code}).`);
}

async function addWebhookChannel(page: Page, workspace: TestWorkspace, url: string): Promise<void> {
  await page.goto(`/w/${workspace.slug}/alerts/settings`);
  const form = await openCreateForm(page, "New channel", "Add a channel", page.getByRole("region", { name: "Channels" }));
  await form.getByLabel("Where to post").selectOption({ label: "Webhook" });
  await form.getByLabel("Channel name").fill("Ops webhook");
  await form.getByLabel("Webhook URL").fill(url);
  await form.getByRole("button", { name: "Add channel" }).click();
  await expect(form.getByRole("status")).toContainText("Channel added.");
}

/**
 * Leaves the command as the only writer to the workspace before the spec counts its events or
 * reads its alerts (#505). Another worker's instance-wide spec ticks at any moment, and two jobs
 * would otherwise land here mid-assertion: a sync of the simulated Vercel connection, due on
 * connect and a minute after every sync (SIMULATED_POLL_INTERVAL_SECONDS), which writes
 * deployments and, during a budget crossing, checks the alert before the command does or puts the
 * usual spend back first; and the workspace's daily summary (src/lib/jobs/schedule.ts), one
 * `stackdash.daily_summary` event. So the connection polls once a day, which the command's own
 * syncs keep, and the spec ticks until the summary has run and no job of the workspace is queued
 * or running, such as a sync queued before the schedule moved.
 */
async function settleWorkspace(page: Page, workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { data: connections, error } = await admin
    .from("connections")
    .update({
      poll_interval_seconds: COMMAND_ONLY_POLL_INTERVAL_SECONDS,
      next_sync_at: new Date(Date.now() + COMMAND_ONLY_POLL_INTERVAL_SECONDS * 1000).toISOString(),
    })
    .eq("workspace_id", workspace.id)
    .select("id");
  if (error) throw new Error(`Rescheduling the connection failed (code ${error.code}).`);
  expect(connections).toHaveLength(1);
  await expect(async () => {
    await tick(page);
    const { data, error: jobsError } = await admin.from("sync_jobs").select("kind, status").eq("workspace_id", workspace.id).limit(100);
    if (jobsError) throw new Error(`Reading the jobs failed (code ${jobsError.code}).`);
    expect(data.filter((job) => job.status === "queued" || job.status === "running")).toEqual([]);
    expect(data.filter((job) => job.kind === "daily_summary").map((job) => job.status)).toEqual(["succeeded"]);
  }).toPass({ timeout: 90_000 });
}

/** Ticks until every alert in the workspace is dispatched; other workspaces' jobs may share a tick. */
async function tickUntilDispatched(page: Page, workspace: TestWorkspace): Promise<void> {
  await expect(async () => {
    await tick(page);
    const { data, error } = await adminClient().from("triggered_alerts").select("dispatched_at").eq("workspace_id", workspace.id).limit(10);
    if (error) throw new Error(`Reading the alerts failed (code ${error.code}).`);
    expect(data).toHaveLength(1);
    expect(data.every((alert) => alert.dispatched_at !== null)).toBe(true);
  }).toPass({ timeout: 90_000 });
}

ownerTest.describe("demo event", () => {
  ownerTest("an incident on cue arrives on the open timeline, and its alert is emailed and posted", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Demo event");
    const receiver = await startReceiver();
    try {
      await connectSimulated(page, workspace.slug, "Vercel");
      await seedBudgetAlert(workspace);
      await addWebhookChannel(page, workspace, receiver.url);
      await settleWorkspace(page, workspace);

      // Simulation off: refused before anything is read or written.
      const before = await countEvents(workspace);
      const refused = await demoEvent("failed-deployment", workspace, "0");
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("Demo event refused. Provider simulation is off.");
      expect(await countEvents(workspace)).toBe(before);

      // A first run fills the timeline: the sync's half hour of deployments, then the incident. The
      // sync sometimes writes a failed production deployment of another project minutes before it,
      // and the timeline then groups the two into one run headed "Deployment failed" (#253, #576).
      // So the spec writes one, making that case the one it always checks, and finds the incident
      // by its id: a row's heading links its newest event.
      expect((await demoEvent("failed-deployment", workspace)).code).toBe(0);
      const first = await latestIncident(workspace);
      await seedSyncFailureBefore(workspace, first);
      const live = watchLiveChannel(page, workspace.id);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expectSubscribed(live);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      const newestLink = events.first().getByRole("heading", { level: 3 }).getByRole("link");
      await expect(newestLink).toHaveAttribute("href", new RegExp(`[?&]event=${first.id}$`));
      await expect(newestLink).toHaveText(FAILED_DEPLOYMENTS_RUN);
      await expect(events.first().getByText(/^,?\s*New$/)).toHaveCount(0);

      // With the timeline open, the next one arrives without a reload: the newest row, marked new.
      // It joins the first row's run when nothing the sync wrote lands between the two incidents,
      // and its "New" then shows on the row and on the event inside it; otherwise it starts a row
      // of its own. Either way the newest row links it.
      const deployment = await demoEvent("failed-deployment", workspace);
      expect(deployment.code).toBe(0);
      expect(deployment.stdout).toContain(`A failed production deployment of web is on the timeline of ${workspace.name}`);
      const second = await latestIncident(workspace);
      expect(second.id).not.toBe(first.id);
      await expect(newestLink).toHaveAttribute("href", new RegExp(`[?&]event=${second.id}$`), { timeout: LIVE_TIMEOUT_MS });
      await expect(events.first().getByText(/^,?\s*New$/).first()).toBeVisible();

      const crossing = await demoEvent("budget-crossing", workspace);
      expect(crossing.code).toBe(0);
      expect(crossing.stdout).toContain("rose to at least $540.00 this month, 90 percent of the Vercel monthly budget of $600.00");
      expect(crossing.stdout).toContain("1 alert triggered");
      // Delivery first, then the render, so a failure says which half broke. A delivery lost while
      // the page stays subscribed has so far been the stack's 10 minute replication rebalance (#555).
      await expect
        .poll(() => deliveredEvent(live, BUDGET_ALERT), { timeout: LIVE_TIMEOUT_MS, message: "Realtime never delivered the budget alert event" })
        .toBe(true);
      const alert = events.filter({ has: page.getByRole("heading", { name: BUDGET_ALERT, exact: true }) });
      await expect(alert).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(alert.getByText(/^,?\s*New$/)).toBeVisible();

      // The next tick sends it: one email to the owner through the fake Resend API, one channel post.
      await tickUntilDispatched(page, workspace);
      await expect(async () => {
        const mail = (await fakeEmails()).filter((email) => email.subject === `Alert in ${workspace.name}: ${BUDGET_ALERT}`);
        expect(mail.map((email) => email.to)).toEqual([[E2E_USERS.owner.email]]);
      }).toPass({ timeout: 30_000 });
      expect(receiver.received.filter((post) => post.body.includes(BUDGET_ALERT))).toHaveLength(1);

      // Already triggered this billing period: a second crossing says so before the sync and writes nothing.
      const written = await countEvents(workspace);
      const again = await demoEvent("budget-crossing", workspace);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(`Nothing written: every budget alert covering Vercel in ${workspace.name} already triggered`);
      expect(await countEvents(workspace)).toBe(written);
    } finally {
      await stopReceiver(receiver.server);
      await deleteTestWorkspace(workspace);
    }
  });
});
