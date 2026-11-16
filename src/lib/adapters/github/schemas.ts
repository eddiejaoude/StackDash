import { z } from "zod";
import { InvalidDecimalError, parseDecimal } from "@/lib/money";
import { OAuthErrorSchema } from "../errors";

/**
 * Zod schemas for every GitHub response the adapter reads, per docs/providers/github.md.
 * Only the fields the adapter uses are declared; anything else in a response is dropped.
 */

/**
 * GitHub billing amounts and quantities are JSON numbers with sub-cent precision. They become
 * exact decimals here, at the parse boundary, so nothing downstream does float arithmetic on them.
 */
const DecimalNumberSchema = z.number().transform((value, ctx) => {
  try {
    return parseDecimal(value);
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      ctx.addIssue(error.message);
      return z.NEVER;
    }
    throw error;
  }
});

// `POST https://github.com/login/oauth/access_token`. GitHub answers OAuth errors with status 200
// and an `error` field, so both shapes are parsed and told apart by the caller.
export const TokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  // Absent when "Expire user authorization tokens" is off for the app.
  expires_in: z.int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
});

export const TokenResponseSchema = z.union([
  TokenSuccessSchema,
  OAuthErrorSchema,
]);
export type TokenSuccess = z.infer<typeof TokenSuccessSchema>;

export const AccountTypeSchema = z.enum(["User", "Organization"]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

// Installation object, as returned by `GET /app/installations/{id}` and inside `GET /user/installations`.
export const InstallationSchema = z.object({
  id: z.int().positive(),
  account: z.object({
    id: z.int().positive(),
    login: z.string().min(1),
    type: AccountTypeSchema,
  }),
  // `{ "metadata": "read", "organization_administration": "read" }`.
  permissions: z.record(z.string(), z.string()).default({}),
  suspended_at: z.string().nullable().optional(),
});
export type Installation = z.infer<typeof InstallationSchema>;

export const UserInstallationsPageSchema = z.object({
  total_count: z.int().nonnegative(),
  installations: z.array(InstallationSchema),
});

export const InstallationTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
});

export const InstallationRepositoriesSchema = z.object({
  total_count: z.int().nonnegative(),
  repositories: z.array(
    z.object({
      id: z.int().positive(),
      name: z.string().min(1),
      full_name: z.string().min(1),
      owner: z.object({ login: z.string().min(1) }),
      html_url: z.url({ protocol: /^https$/ }),
    }),
  ),
});
export type Repository = z.infer<
  typeof InstallationRepositoriesSchema
>["repositories"][number];

export const StargazersCountSchema = z.object({ count: z.int().nonnegative() });

// `GET /repos/{owner}/{repo}/forks`. Only the fork id and creation time are read: the fork's
// name and owner are another person's account, and StackDash stores no personal data.
export const ForksSchema = z.array(
  z.object({
    id: z.int().positive(),
    created_at: z.iso.datetime({ offset: true }),
  }),
);
export type Fork = z.infer<typeof ForksSchema>[number];

// Activity reads and webhook bodies (#62) keep only a number or id, a time, and a link: titles,
// bodies, labels, and authors are written by people (anyone can open an issue on a public
// repository), so they are never parsed. A link is a plain string here and dropped later unless it
// is https, so a host that sends another scheme loses the link rather than the event.

// `GET /repos/{owner}/{repo}/pulls?state=closed`. Closed but unmerged pull requests have no
// `merged_at`. `updated_at` orders the list, so it shows whether a page reached back far enough.
export const PullRequestSchema = z.object({
  number: z.int().positive(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  updated_at: z.iso.datetime({ offset: true }),
  html_url: z.string(),
});
export const PullRequestsSchema = z.array(PullRequestSchema);
export type PullRequest = z.infer<typeof PullRequestSchema>;

// `GET /repos/{owner}/{repo}/issues?state=all`. The list holds pull requests too, marked by a
// `pull_request` key, which the caller skips.
export const IssueSchema = z.object({
  number: z.int().positive(),
  created_at: z.iso.datetime({ offset: true }),
  html_url: z.string(),
  pull_request: z.object({}).optional(),
});
export const IssuesSchema = z.array(IssueSchema);
export type Issue = z.infer<typeof IssueSchema>;

// The release object (`GET /repos/{owner}/{repo}/releases/{release_id}`), as a `ReleaseEvent` in the
// repository events feed carries it. A draft has no `published_at` until it is published.
export const ReleaseSchema = z.object({
  id: z.int().positive(),
  tag_name: z.string().min(1),
  draft: z.boolean(),
  published_at: z.iso.datetime({ offset: true }).nullable(),
  html_url: z.string(),
});
export type Release = z.infer<typeof ReleaseSchema>;

// `GET /repos/{owner}/{repo}/events`, roughly newest first, every event type. Only a `ReleaseEvent` is read,
// and its `payload.release` must hold the release object: a release event whose payload drifted
// matches neither shape, so the page fails to parse rather than losing releases silently. `actor`
// (the person) and every other event's payload are never declared, so they are dropped here.
const ReleaseFeedEventSchema = z.object({
  type: z.literal("ReleaseEvent"),
  created_at: z.iso.datetime({ offset: true }),
  payload: z.object({ action: z.string(), release: ReleaseSchema }),
});
const OtherFeedEventSchema = z.object({
  type: z.string().refine((type) => type !== "ReleaseEvent"),
  created_at: z.iso.datetime({ offset: true }),
});
export const RepositoryEventsSchema = z.array(
  z.union([ReleaseFeedEventSchema, OtherFeedEventSchema]),
);

// The repository in a webhook body. An app installation covers one account's repositories, so the
// owner's id is the installation account's id: the external account the delivery belongs to.
const WebhookRepositorySchema = z.object({
  id: z.int().positive(),
  full_name: z.string().min(1),
  html_url: z.string(),
  owner: z.object({ id: z.int().positive() }),
});

// `X-GitHub-Event: pull_request`. A merge arrives as `closed` with `merged: true`.
export const PullRequestDeliverySchema = z.object({
  action: z.string(),
  repository: WebhookRepositorySchema,
  pull_request: PullRequestSchema.extend({
    merged: z.boolean().nullable().optional(),
  }),
});

// `X-GitHub-Event: issues`.
export const IssuesDeliverySchema = z.object({
  action: z.string(),
  repository: WebhookRepositorySchema,
  issue: IssueSchema,
});

// `X-GitHub-Event: star`. `starred_at` is null on `deleted`. The stargazer (`sender`) is not read.
export const StarDeliverySchema = z.object({
  action: z.string(),
  repository: WebhookRepositorySchema,
  starred_at: z.iso.datetime({ offset: true }).nullable(),
});

// `X-GitHub-Event: installation`. Only the account id and the suspension time are read; GitHub
// sends the installation's own `created_at` and `updated_at` as either epoch seconds or ISO
// strings, so neither is declared.
export const InstallationDeliverySchema = z.object({
  action: z.string(),
  installation: z.object({
    account: z.object({ id: z.int().positive() }),
    suspended_at: z.iso.datetime({ offset: true }).nullable().optional(),
  }),
});

// `X-GitHub-Event: github_app_authorization`. Only the revoking user's account id is read.
export const AppAuthorizationDeliverySchema = z.object({
  action: z.string(),
  sender: z.object({ id: z.int().positive() }),
});

// `GET /{organizations/{org}|users/{username}}/settings/billing/usage`: daily line items.
export const BillingUsageSchema = z.object({
  usageItems: z.array(
    z.object({
      // One UTC day, `YYYY-MM-DD`.
      date: z.iso.date(),
      product: z.string().min(1),
      sku: z.string().min(1),
      unitType: z.string().min(1),
      netAmount: DecimalNumberSchema,
    }),
  ),
});
export type BillingUsageItem = z.infer<
  typeof BillingUsageSchema
>["usageItems"][number];

// Shared by `/usage/summary`, `/ai_credit/usage`, and `/premium_request/usage`: aggregated items.
export const AggregatedUsageSchema = z.object({
  usageItems: z.array(
    z.object({
      product: z.string().min(1),
      sku: z.string().min(1),
      unitType: z.string().min(1),
      grossQuantity: DecimalNumberSchema,
      netAmount: DecimalNumberSchema,
    }),
  ),
});
export type AggregatedUsageItem = z.infer<
  typeof AggregatedUsageSchema
>["usageItems"][number];
