import { z } from "zod";

/**
 * Zod schemas for every Sentry response the adapter reads (docs/providers/sentry.md). Each one names
 * only the fields the adapter uses, so everything else is dropped at this boundary by never being
 * declared: issue titles, messages, culprits, assignees, and release authors and commits can all
 * carry personal data from the user's app or team.
 */

const isoDateTime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

// Sentry renders ids as strings in most responses and as numbers in some (a release `id`).
const IdSchema = z.union([z.string().regex(/^\d+$/), z.int().nonnegative()]).transform(String);

// Short ids go into a search query (`issue:[...]`), so anything that could break out of the list
// syntax is refused here rather than escaped.
export const SHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * `POST /api/0/sentry-app-installations/{uuid}/authorizations/`, for the code exchange and for the
 * JWT bearer refresh alike. `refreshToken` is also returned but never read: StackDash refreshes with
 * the JWT bearer grant Sentry recommends, so it is never declared and never stored.
 */
export const TokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: isoDateTime,
});

const ProjectSchema = z.object({
  id: IdSchema,
  slug: z.string().min(1),
  name: z.string().nullish(),
});

/** `GET /api/0/organizations/{organization_id_or_slug}/projects/`, one page. */
export const ProjectsPageSchema = z.array(ProjectSchema);

/**
 * `GET /api/0/organizations/{organization_id_or_slug}/stats_v2/` grouped by `outcome`. A group is
 * only present for outcomes that had events, so a missing one means zero.
 */
export const StatsResponseSchema = z.object({
  start: isoDateTime,
  end: isoDateTime,
  groups: z.array(
    z.object({
      by: z.object({ outcome: z.string().min(1) }),
      totals: z.record(z.string(), z.number().nonnegative()),
    }),
  ),
});

export type StatsResponse = z.infer<typeof StatsResponseSchema>;

const IssueSchema = z.object({
  id: IdSchema,
  shortId: z.string().regex(SHORT_ID_PATTERN),
  // `unresolved`, `resolved`, `ignored`, and others; compared, never enumerated, so a new value
  // Sentry adds is ignored rather than failing the sync.
  status: z.string().min(1),
  substatus: z.string().nullish(),
  level: z.string().nullish(),
  firstSeen: isoDateTime,
  lastSeen: isoDateTime,
  permalink: z.string().nullish(),
});

/** `GET /api/0/organizations/{organization_id_or_slug}/issues/`, one page. */
export const IssuesPageSchema = z.array(IssueSchema);

export type Issue = z.infer<typeof IssueSchema>;

const ReleaseSchema = z.object({
  id: IdSchema,
  version: z.string().min(1),
  shortVersion: z.string().nullish(),
  dateCreated: isoDateTime,
});

/** `GET /api/0/organizations/{organization_id_or_slug}/releases/`, newest first, one page. */
export const ReleasesPageSchema = z.array(ReleaseSchema);

export type Release = z.infer<typeof ReleaseSchema>;
