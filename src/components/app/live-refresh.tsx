"use client";

import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

import { useArrivalControls } from "@/components/app/arrivals";
import { redactFields } from "@/lib/log/redact";
import { changedConnectionId } from "@/lib/realtime/arrivals";
import { createRefreshScheduler, type RefreshScheduler } from "@/lib/realtime/refresh-scheduler";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

// The sync-written tables the workspace screens read, and exactly the tables the realtime
// publication holds (supabase/migrations/20261104090000_realtime_publication.sql). The user-edited
// tables the screens also read refresh through the Server Function that edits them.
const LIVE_TABLES = [
  "activity_events",
  "usage_snapshots",
  "connections",
  "triggered_alerts",
] as const satisfies readonly (keyof Database["public"]["Tables"])[];

const LIVE_EVENTS = ["INSERT", "UPDATE"] as const;

/** What onChange reads from a postgres_changes payload; `new` is the whole row (default replica identity). */
type LiveChange = Readonly<{ commit_timestamp: string; table: string; new: unknown }>;

// Realtime hands back an existing channel for a topic it still holds, and a removed channel stays
// held until the server acknowledges the leave. A subscription made inside that window (leaving a
// workspace and coming straight back) would attach to the departing channel and never join, so
// every mount gets a topic of its own.
let mountCount = 0;

/**
 * Refreshes the current workspace page when a sync writes rows for this workspace (#129), so the
 * Server Components read again and no row data is copied into client state. The one exception is
 * an id: the connection each usage snapshot or provider event came from, which the store keeps
 * with the last batch that brought it so the indicator can say which connection is receiving
 * (#392). One channel per
 * workspace, removed when the workspace layout unmounts or the workspace changes. Realtime checks
 * every change against the subscriber's select policy, so a member only hears about their own
 * workspace; the filter keeps a member of several workspaces from hearing about the others.
 *
 * Renders nothing. If the subscription fails, the failure is logged at error level and the page
 * behaves as it did before live updates: it shows new data on the next navigation or reload.
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
    // The newest commit among the changes delivered so far: the database's clock, not the browser's.
    let lastCommitAt: string | null = null;
    // The connections that sent provider data since the last refresh (changedConnectionId), for the
    // indicator's list (#392).
    let changedConnections = new Set<string>();
    const scheduler = createRefreshScheduler({
      refresh: () => {
        arrivals?.arrived(lastCommitAt, changedConnections);
        changedConnections = new Set();
        startRefresh(() => refresh());
      },
      isHidden: () => document.visibilityState === "hidden",
    });
    schedulerRef.current = scheduler;
    const onVisibilityChange = () => scheduler.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibilityChange);
    const onChange = ({ commit_timestamp: committedAt, table, new: row }: LiveChange) => {
      if (lastCommitAt === null || Date.parse(committedAt) > Date.parse(lastCommitAt)) lastCommitAt = committedAt;
      const connectionId = changedConnectionId(table, row);
      if (connectionId !== null) changedConnections.add(connectionId);
      scheduler.notify();
    };

    let channel: RealtimeChannel | undefined;
    let active = true;
    function subscribe(): void {
      if (!active) return;
      const filter = `workspace_id=eq.${workspaceId}`;
      channel = supabase.channel(`workspace-live:${workspaceId}:${++mountCount}`);
      for (const table of LIVE_TABLES) {
        for (const event of LIVE_EVENTS) {
          channel.on("postgres_changes", { event, schema: "public", table, filter }, onChange);
        }
      }
      channel.subscribe((status, error) => {
        if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) arrivals?.setStatus("live");
        if (status !== REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR && status !== REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
          return;
        }
        arrivals?.setStatus("offline");
        // One JSON line per failure, shaped like the server logger's (src/lib/log/logger.ts, which
        // is server only), so it reads the same in devtools and in the Playwright console. The
        // fields hold no token; redaction masks one if a future error carries it.
        console.error(
          JSON.stringify({
            ...redactFields({ workspaceId, status, error }),
            level: "error",
            event: "realtime.subscribe_failed",
          }),
        );
      });
    }

    // The join message carries whatever access token the realtime client holds at subscribe time.
    // supabase-js fills it asynchronously (from getSession, on connect and on the initial auth
    // event), so a channel created first can join with the publishable key alone, and Realtime then
    // checks every change as anon and delivers nothing. setAuth() with no argument loads the signed
    // in user's token through that same getSession callback and keeps the client refreshing it on
    // every heartbeat. If it fails, subscribing still leaves the decision to Realtime and RLS.
    void supabase.realtime.setAuth().then(subscribe, subscribe);

    return () => {
      active = false;
      scheduler.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (channel !== undefined) void supabase.removeChannel(channel);
      arrivals?.setStatus("connecting");
    };
  }, [refresh, workspaceId, arrivals]);

  return null;
}
