import "server-only";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";

import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Who is online on a support topic right now (#680), asked before an email goes out: email goes to
 * the other side only when they are not watching (src/lib/support/notify.ts). The server joins the
 * private topic with the service role, which every Realtime policy admits, reads the presence state
 * Realtime sends on join, and leaves. A user tracks on their own topic, so any key there means that
 * user has a tab open; operators track on the operators' topic with their user id as the key.
 *
 * Null when Realtime refuses the join or does not answer in time: the caller then emails, because
 * an unneeded email costs less than a reply nobody hears about. So a failed probe is a warning: the
 * email still goes out.
 */

export const PRESENCE_PROBE_TIMEOUT_MS = 4000;

type ProbeOutcome = "answered" | "refused" | "timed_out";

export async function presenceKeys(topic: string, timeoutMs: number = PRESENCE_PROBE_TIMEOUT_MS): Promise<ReadonlySet<string> | null> {
  const supabase = createAdminClient();
  const channel = supabase.channel(topic, { config: { private: true, presence: { enabled: true } } });
  const answer = Promise.withResolvers<ReadonlySet<string> | null>();
  // Set by whichever callback answers first; the others then do nothing.
  const probe: { outcome: ProbeOutcome | null } = { outcome: null };
  const settle = (outcome: ProbeOutcome, keys: ReadonlySet<string> | null) => {
    if (probe.outcome !== null) return;
    probe.outcome = outcome;
    answer.resolve(keys);
  };
  const timer = setTimeout(() => settle("timed_out", null), timeoutMs);
  channel
    .on("presence", { event: "sync" }, () => settle("answered", new Set(Object.keys(channel.presenceState()))))
    .subscribe((status, error) => {
      // A status after the answer is this probe leaving the channel.
      if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED || probe.outcome !== null) return;
      log.warn("support.presence_probe_refused", { topic, status, reason: error?.message ?? null });
      settle("refused", null);
    });
  try {
    const keys = await answer.promise;
    if (probe.outcome === "timed_out") log.warn("support.presence_probe_timed_out", { topic, timeoutMs });
    return keys;
  } finally {
    clearTimeout(timer);
    // The client is this probe's alone: removing its only channel leaves the socket open.
    await supabase.removeChannel(channel);
    supabase.realtime.disconnect();
  }
}
