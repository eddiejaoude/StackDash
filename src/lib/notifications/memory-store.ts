import type { DashboardInput } from "@/lib/dashboard/aggregate";
import type { EmailMessage, EmailTransport, MessageIdLookup } from "@/lib/email/send";
import type { EventRow } from "@/lib/jobs/store";
import type { Logger } from "@/lib/log/logger";

import type { ChannelSecret, PostOutcome } from "./channels";
import type { DeliveryRecord, DestinationHealthPatch, NotificationDeps, NotificationStore, WorkspaceInfo } from "./dispatch";
import { deliveryKey, type DeliveryAlert, type DeliveryDestination, type Recipient } from "./model";
import type { DigestHighlights } from "./notice";

/*
 * In-memory NotificationStore and deps for unit tests only. It mirrors what the jobs rely on: the
 * (workspace, subject, target) unique key on deliveries, the dispatched_at filter, and the event
 * dedupe key. Never imported by app code.
 */

export type MemoryAlert = DeliveryAlert & { workspaceId: string; dispatchedAt: string | null };
export type MemoryDestination = DeliveryDestination & {
  workspaceId: string;
  secret: ChannelSecret | null;
  lastErrorCode: string | null;
  lastErrorReference: string | null;
  lastDeliveredAt: string | null;
};

export class MemoryNotificationStore implements NotificationStore {
  workspaces: WorkspaceInfo[] = [];
  alerts: MemoryAlert[] = [];
  recipients = new Map<string, Recipient[]>();
  destinations: MemoryDestination[] = [];
  deliveries: DeliveryRecord[] = [];
  events: EventRow[] = [];
  dashboards = new Map<string, DashboardInput>();
  highlights: DigestHighlights = { deploys: 0, signups: 0, stars: 0, payments: 0 };

  async getWorkspace(workspaceId: string): Promise<WorkspaceInfo | null> {
    return this.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  async listUndispatchedAlerts(workspaceId: string, limit: number): Promise<DeliveryAlert[]> {
    return this.alerts.filter((alert) => alert.workspaceId === workspaceId && alert.dispatchedAt === null).slice(0, limit);
  }

  async listAlertsTriggeredBetween(workspaceId: string, start: string, end: string, limit: number): Promise<DeliveryAlert[]> {
    return this.alerts
      .filter(
        (alert) =>
          alert.workspaceId === workspaceId && Date.parse(alert.triggeredAt) >= Date.parse(start) && Date.parse(alert.triggeredAt) < Date.parse(end),
      )
      .slice(0, limit);
  }

  async listRecipients(workspaceId: string): Promise<Recipient[]> {
    return this.recipients.get(workspaceId) ?? [];
  }

  async listDestinations(workspaceId: string): Promise<DeliveryDestination[]> {
    return this.destinations.filter((destination) => destination.workspaceId === workspaceId);
  }

  async loadDestinationSecret(workspaceId: string, destinationId: string): Promise<ChannelSecret | null> {
    return this.destinations.find((row) => row.workspaceId === workspaceId && row.id === destinationId)?.secret ?? null;
  }

  async listDeliveries(workspaceId: string, subjectKeys: readonly string[]): Promise<Set<string>> {
    return new Set(
      this.deliveries
        .filter((record) => record.workspaceId === workspaceId && subjectKeys.includes(record.subjectKey))
        .map((record) => deliveryKey(record.subjectKey, record.target.key)),
    );
  }

  async recordDeliveries(records: readonly DeliveryRecord[]): Promise<void> {
    for (const record of records) {
      const exists = this.deliveries.some(
        (row) => row.workspaceId === record.workspaceId && row.subjectKey === record.subjectKey && row.target.key === record.target.key,
      );
      if (!exists) this.deliveries.push(record);
    }
  }

  async markDispatched(workspaceId: string, alertIds: readonly string[], at: Date): Promise<void> {
    for (const alert of this.alerts) {
      if (alert.workspaceId === workspaceId && alertIds.includes(alert.id)) alert.dispatchedAt = at.toISOString();
    }
  }

  async updateDestinationHealth(workspaceId: string, destinationId: string, patch: DestinationHealthPatch): Promise<void> {
    const index = this.destinations.findIndex((row) => row.workspaceId === workspaceId && row.id === destinationId);
    const row = this.destinations[index];
    if (row === undefined) return;
    this.destinations[index] = {
      ...row,
      status: patch.status,
      consecutiveFailures: patch.consecutive_failures,
      lastErrorCode: patch.last_error_code,
      lastErrorReference: patch.last_error_reference,
      lastDeliveredAt: patch.last_delivered_at ?? row.lastDeliveredAt,
    };
  }

  async insertEvents(rows: readonly EventRow[]): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      if (this.events.some((event) => event.workspace_id === row.workspace_id && event.dedupe_key === row.dedupe_key)) continue;
      this.events.push(row);
      inserted += 1;
    }
    return inserted;
  }

  async loadDashboardInput(workspaceId: string, now: Date): Promise<DashboardInput> {
    return this.dashboards.get(workspaceId) ?? { connections: [], accounts: [], projects: [], snapshots: [], projectedSpend: [], now };
  }

  async countHighlights(): Promise<DigestHighlights> {
    return this.highlights;
  }
}

/** An email transport that keeps what it sends; `fail` makes the next sends throw. */
export class MemoryEmailTransport implements EmailTransport {
  sent: EmailMessage[] = [];
  fail: Error | null = null;

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    if (this.fail !== null) throw this.fail;
    this.sent.push(message);
    return { messageId: `memory-${this.sent.length}` };
  }

  async rfcMessageId(emailId: string): Promise<MessageIdLookup> {
    return { messageId: `<${emailId}@memory.test>` };
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Deps for the notification jobs with nothing configured; tests override what they exercise. */
export function memoryNotificationDeps(overrides: Partial<NotificationDeps> = {}): NotificationDeps {
  return {
    store: new MemoryNotificationStore(),
    email: null,
    post: async (): Promise<PostOutcome> => ({ ok: true, attempts: 1 }),
    origin: () => "https://stackdash.test",
    unsubscribeToken: (workspaceId, userId) => `token-${workspaceId}-${userId}`,
    now: () => new Date("2026-11-05T09:00:00.000Z"),
    random: () => 0.5,
    newId: () => "00000000-0000-4000-8000-000000000000",
    logError: () => "REF-TEST0000",
    log: silent,
    ...overrides,
  };
}
