"use client";

import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

import { useArrivalControls } from "@/components/app/arrivals";
import { redactFields } from "@/lib/log/redact";
import { LIVE_CHANGE_EVENT, liveChange, liveSystemMessage, liveTopic } from "@/lib/realtime/arrivals";
import { createRefreshHolds, createRefreshScheduler, type RefreshScheduler } from "@/lib/realtime/refresh-scheduler";
import { createClient } from "@/lib/supabase/client";

// realtime-js joins again on its own after a channel error or a timed out join, but not after
// Realtime closes the channel (`phx_close`): when the access token expired or lost the workspace,
// or its database stream did not start within a minute. LiveRefresh joins again itself after this
// long, the longest of realtime-js's own waits between joins.
const REJOIN_AFTER_CLOSE_MS = 10_000;

// One LiveRefresh runs per page, so the page's holds live beside it.
const holds = createRefreshHolds();

/**
 * Makes live refreshes wait until the returned function runs; the changes that arrive meanwhile
 * refresh once then. For a page whose URL says something the router has not rendered: a refresh
 * then fetches the URL but keeps the router's rendered search, and Next.js caches that page empty
 * under it, so going Back to it suspends the page for good (#477).
 */
export function holdLiveRefresh(): () => void {
  return holds.hold();
}

/**
 * Refreshes the current workspace page when a sync writes rows for this workspace (#129), so the
 * Server Components read again and no row data is copied into client state. The one exception is
 * an id: the connection each change brought provider data from, which the store keeps with the last
 * batch that brought it so the indicator can say which connection is receiving (#392).
 *
 * It listens to the workspace's private Broadcast topic (`liveTopic`), where the database sends one
 * message for each statement that inserts or updates the workspace's activity events, usage
 * snapshots, connections, or triggered alerts, whatever its row count (#628,
 * supabase/migrations/20261122210934_live_refresh_broadcast.sql). Realtime lets a channel join the
 * topic only when the signed-in user is a member of the workspace (the realtime.messages select
 * policy), checks again whenever the client sends a new access token, and lets no client send on
 * it. One channel per workspace, removed when the workspace layout unmounts or the workspace
 * changes.
 *
 * Renders nothing. If the subscription fails, the failure is logged at error level, with
 * Realtime's reason when it closed the channel, and the page behaves as it did before live
 * updates: it shows new data on the next navigation or reload. It joins again, and once a later
 * join's database stream is ready it refreshes once, for the changes written while it was away.
 * It tells the ArrivalProvider whether the channel is live, when each batch arrives, and which
 * connections it brought data from, which the live indicator in the header shows (#171, #392).
 *
 * One refresh runs at a time (#309, src/lib/realtime/refresh-scheduler.ts). `router.refresh()`
 * returns nothing, and its router action settles as soon as the request is spawned
 * (node_modules/next/dist/client/components/app-router-state.js, `navigateToKnownRoute`), so the
 * router itself never holds a second refresh back. What does wait is the render: the router sets
 * its state in a transition (app-router-instance.js, `dispatchAction`) that joins the one started
 * here, and the new tree suspends on the refreshed payload. So `isPending` turns false once that
 * payload is on screen. A navigation during a refresh updates the same router state, and React
 * entangles transition updates to one state (`entangleTransitionUpdate` in react-dom), so both
 * commit together and the refresh still ends. e2e/realtime.spec.ts covers both cases.
 */
export function LiveRefresh({ workspaceId }: { workspaceId: string }) {
  // `refresh` is the app router's own method, stable across renders, unlike the object around it.
  const { refresh } = useRouter();
  const arrivals = useArrivalControls();
  const [refreshing, startRefresh] = useTransition();
  const schedulerRef = useRef<RefreshScheduler | null>(null);

  useEffect(() => {
    if (!refreshing) schedulerRef.current?.settled();
  }, [refreshing]);

  useEffect(() => {
    // The browser client is a singleton, so this channel shares the one socket of the page.
    const supabase = createClient();
    // When the newest change delivered so far was written: the database's clock, not the browser's.
    let lastChangeAt: string | null = null;
    // The connections that sent provider data since the last refresh (LiveChange), for the
    // indicator's list (#392).
    let changedConnections = new Set<string>();
    const scheduler = createRefreshScheduler({
      refresh: () => {
        arrivals?.arrived(lastChangeAt, changedConnections);
        changedConnections = new Set();
        startRefresh(() => refresh());
      },
      isPaused: () => document.visibilityState === "hidden" || holds.held(),
    });
    schedulerRef.current = scheduler;
    const onPauseChange = () => scheduler.pauseChanged();
    document.addEventListener("visibilitychange", onPauseChange);
    const stopHearingReleases = holds.onReleased(onPauseChange);
    // Every message is a write to refresh for; one of another shape adds nothing to the indicator.
    const onChange = ({ payload }: { payload: unknown }) => {
      const change = liveChange(payload);
      if (change !== null) {
        if (lastChangeAt === null || Date.parse(change.changedAt) > Date.parse(lastChangeAt)) lastChangeAt = change.changedAt;
        for (const connectionId of change.connectionIds) changedConnections.add(connectionId);
      }
      scheduler.notify();
    };

    let channel: RealtimeChannel | undefined;
    let rejoinTimer: number | undefined;
    let active = true;
    // Whether a join of this mount has had its database stream ready. A later join follows a close
    // or a channel error, and a change written in between was never delivered.
    let streamReadyBefore = false;
    // Why Realtime closed the channel: it sends the reason as a system message just before.
    let closeReason: string | undefined;
    const onSystem = (payload: unknown) => {
      const message = liveSystemMessage(payload);
      if (message === null) return;
      if (!message.ok) {
        closeReason = message.message;
        return;
      }
      // Every change committed from here on reaches the channel; one refresh shows those before.
      if (streamReadyBefore) scheduler.notify();
      streamReadyBefore = true;
    };
    function subscribe(): void {
      if (!active) return;
      // `replication_ready` makes Realtime send a `system` message once the replication connection
      // that carries the database's messages is up, which `onSystem` and the e2e fixtures wait for
      // (e2e/fixtures/realtime.ts), and close the channel if that connection is not up within a
      // minute. The close shows as offline below, rather than a channel that says live and can
      // receive nothing.
      channel = supabase
        .channel(liveTopic(workspaceId), { config: { private: true, broadcast: { replication_ready: true } } })
        .on("broadcast", { event: LIVE_CHANGE_EVENT }, onChange)
        .on("system", {}, onSystem)
        .subscribe((status, error) => {
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            arrivals?.setStatus("live");
            return;
          }
          // The cleanup below removed it.
          if (!active) return;
          arrivals?.setStatus("offline");
          // One JSON line per failure, shaped like the server logger's (src/lib/log/logger.ts, which
          // is server only), so it reads the same in devtools and in the Playwright console. The
          // fields hold no token; redaction masks one if a future error carries it.
          console.error(
            JSON.stringify({
              ...redactFields({ workspaceId, status, error, reason: closeReason }),
              level: "error",
              event: "realtime.subscribe_failed",
            }),
          );
          closeReason = undefined;
          if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) rejoinTimer = window.setTimeout(subscribe, REJOIN_AFTER_CLOSE_MS);
        });
    }

    // The join message carries whatever access token the realtime client holds at subscribe time,
    // and a private channel is checked against it. supabase-js fills it asynchronously (from
    // getSession, on connect and on the initial auth event), so a channel created first can join
    // with the publishable key alone, which Realtime refuses on this topic. setAuth() with no
    // argument loads the signed in user's token through that same getSession callback and keeps
    // the client refreshing it on every heartbeat, as Supabase's Broadcast guide requires
    // (https://supabase.com/docs/guides/realtime/subscribing-to-database-changes). If it fails,
    // subscribing still leaves the decision to Realtime and the policy.
    void supabase.realtime.setAuth().then(subscribe, subscribe);

    return () => {
      active = false;
      window.clearTimeout(rejoinTimer);
      scheduler.dispose();
      document.removeEventListener("visibilitychange", onPauseChange);
      stopHearingReleases();
      // removeChannel takes the channel out of the client's list before it returns, so a mount that
      // follows straight after, which joins the same topic, gets a new channel rather than this one.
      if (channel !== undefined) void supabase.removeChannel(channel);
      arrivals?.setStatus("connecting");
    };
  }, [refresh, workspaceId, arrivals]);

  return null;
}
