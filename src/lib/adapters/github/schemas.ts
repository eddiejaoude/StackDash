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

export const TokenResponseSchema = z.union([TokenSuccessSchema, OAuthErrorSchema]);
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
export type Repository = z.infer<typeof InstallationRepositoriesSchema>["repositories"][number];

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
export type BillingUsageItem = z.infer<typeof BillingUsageSchema>["usageItems"][number];

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
export type AggregatedUsageItem = z.infer<typeof AggregatedUsageSchema>["usageItems"][number];
