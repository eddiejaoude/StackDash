"use client";

import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import { useEffect, useEffectEvent, useState } from "react";

import { redactFields } from "@/lib/log/redact";
import { liveSystemMessage } from "@/lib/realtime/arrivals";
import { createClient } from "@/lib/supabase/client";
import { SUPPORT_ACTIVITY_EVENT, supportActivity, supportUserTopic, type SupportActivity } from "@/lib/support/live";

/*
 * Support chat's Realtime topics in the browser (#680), joined the way LiveRefresh joins a workspace
 * topic (src/components/app/live-refresh.tsx): a private channel, the user's access token loaded
 * first with setAuth(), a join again after Realtime closes the channel, and the channel removed when
 * the component unmounts or the topic changes. Topics and payloads: src/lib/support/live.ts.
 *
 * A hint carries no content, so a listener reads again through the server on every hint and after
 * every reconnect (`onReconnect`): Broadcast does not replay what was sent while a channel was away.
 */

// realtime-js joins again on its own after an error or a timed out join, but not after Realtime
// closes the channel; this waits as long as LiveRefresh does before joining again.
const REJOIN_AFTER_CLOSE_MS = 10_000;

export type SupportChannelStatus = "connecting" | "live" | "offline";

type JoinOptions = Readonly<{
  topic: string;
  /** Tracks presence on the topic under this key: the user on their own topic, an operator on the operators' topic. */
  presenceKey: string | null;
  onActivity: ((activity: SupportActivity) => void) | null;
  onPresence: ((keys: ReadonlySet<string>) => void) | null;
  onStatus: (status: SupportChannelStatus, joinedBefore: boolean) => void;
}>;

/** Joins one private support topic until the returned function leaves it. */
function joinSupportTopic(options: JoinOptions): () => void {
  // The browser client is a singleton, so every channel shares the page's one socket.
  const supabase = createClient();
  let channel: RealtimeChannel | undefined;
  let rejoinTimer: number | undefined;
  let active = true;
  let joinedBefore = false;
  let closeReason: string | undefined;

  function subscribe(): void {
    if (!active) return;
    const presence = options.presenceKey === null ? {} : { key: options.presenceKey };
    const next = supabase.channel(options.topic, {
      config: { private: true, presence: { ...presence, enabled: options.onPresence !== null } },
    });
    if (options.onActivity !== null) {
      const onActivity = options.onActivity;
      next.on("broadcast", { event: SUPPORT_ACTIVITY_EVENT }, ({ payload }: { payload: unknown }) => {
        const activity = supportActivity(payload);
        if (activity !== null) onActivity(activity);
      });
    }
    if (options.onPresence !== null) {
      const onPresence = options.onPresence;
      next.on("presence", { event: "sync" }, () => onPresence(new Set(Object.keys(next.presenceState()))));
    }
    next.on("system", {}, (payload: unknown) => {
      const message = liveSystemMessage(payload);
      if (message !== null && !message.ok) closeReason = message.message;
    });
    channel = next.subscribe((status, error) => {
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
        options.onStatus("live", joinedBefore);
        joinedBefore = true;
        if (options.presenceKey !== null) void next.track({ online_at: new Date().toISOString() });
        return;
      }
      // The cleanup below removed it.
      if (!active) return;
      options.onStatus("offline", joinedBefore);
      console.error(
        JSON.stringify({
          ...redactFields({ topic: options.topic, status, error, reason: closeReason }),
          level: "error",
          event: "support.realtime_subscribe_failed",
        }),
      );
      closeReason = undefined;
      if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) rejoinTimer = window.setTimeout(subscribe, REJOIN_AFTER_CLOSE_MS);
    });
  }

  // A private channel is checked against the token the client holds when it joins, which
  // supabase-js loads asynchronously: setAuth() loads it first (see LiveRefresh).
  void supabase.realtime.setAuth().then(subscribe, subscribe);

  return () => {
    active = false;
    window.clearTimeout(rejoinTimer);
    if (channel !== undefined) void supabase.removeChannel(channel);
  };
}

export type SupportChannelOptions = Readonly<{
  /** `supportUserTopic(userId)` for the signed-in user, SUPPORT_OPERATORS_TOPIC for an operator, or null to stay off. */
  topic: string | null;
  /** Called with each hint. Read the thread or the list again through the server. */
  onActivity: (activity: SupportActivity) => void;
  /** Called when a channel that was live joins again: read everything again, hints may have been missed. */
  onReconnect?: () => void;
  /**
   * The signed-in user's id, to be shown online: on the user's own topic, so operators see them and
   * support email waits; on the operators' topic, so other operators' email skips them. Never pass
   * an operator's id on a user's topic: Realtime refuses that track.
   */
  presenceKey?: string;
}>;

/**
 * Listens to one support topic while mounted. Returns the channel's status, for a "live" or
 * "reconnecting" hint in the UI.
 */
export function useSupportChannel({ topic, onActivity, onReconnect, presenceKey }: SupportChannelOptions): SupportChannelStatus {
  const [status, setStatus] = useState<SupportChannelStatus>("connecting");
  const activity = useEffectEvent((hint: SupportActivity) => onActivity(hint));
  const reconnect = useEffectEvent(() => onReconnect?.());

  useEffect(() => {
    if (topic === null) return;
    const leave = joinSupportTopic({
      topic,
      presenceKey: presenceKey ?? null,
      onActivity: (hint) => activity(hint),
      onPresence: null,
      onStatus: (next, joinedBefore) => {
        setStatus(next);
        if (next === "live" && joinedBefore) reconnect();
      },
    });
    return () => {
      leave();
      setStatus("connecting");
    };
  }, [topic, presenceKey]);

  return status;
}

/** At most this many users' topics an operator joins at once for presence. */
export const MAX_PRESENCE_WATCH = 50;

/**
 * For operators: which of these users are online now, from presence on each user's own topic (the
 * user tracks there; no one else can). Joins one channel per id, up to MAX_PRESENCE_WATCH, and
 * leaves each when its id is no longer passed or the component unmounts. Pass the user ids of the
 * list rows on screen. Empty until each channel reports.
 */
export function useOnlineMembers(userIds: readonly string[]): ReadonlySet<string> {
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());
  // A string key, so a new array with the same ids does not join everything again.
  const key = [...new Set(userIds)].sort().slice(0, MAX_PRESENCE_WATCH).join(",");

  useEffect(() => {
    if (key === "") return;
    const ids = key.split(",");
    const leaves = ids.map((userId) =>
      joinSupportTopic({
        topic: supportUserTopic(userId),
        presenceKey: null,
        onActivity: null,
        onPresence: (keys) =>
          setOnline((previous) => {
            const next = new Set(previous);
            if (keys.size > 0) next.add(userId);
            else next.delete(userId);
            return next;
          }),
        onStatus: (status) => {
          if (status === "offline") setOnline((previous) => new Set([...previous].filter((id) => id !== userId)));
        },
      }),
    );
    return () => {
      for (const leave of leaves) leave();
      setOnline(new Set());
    };
  }, [key]);

  return online;
}
