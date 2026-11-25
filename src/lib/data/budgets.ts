import "server-only";

import { cache } from "react";

import { joinAlertSnapshots, type AlertSnapshotInput } from "@/lib/alerts/evaluate";
import type { BudgetValues } from "@/lib/alerts/rule-schema";
import { snapshotWindowStart } from "@/lib/dashboard/aggregate";
import { afterCursorFilter, decodeCursor, encodeCursor, type Page } from "@/lib/data/cursor";
import { getWorkspaceScope, loadSnapshots } from "@/lib/data/dashboard";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Budgets: monthly spending limits a workspace sets for itself, separate from the allowances a
 * provider plan includes. Same access model as alert rules (see alert-rules.ts).
 */

export type Budget = Pick<
  Database["public"]["Tables"]["budgets"]["Row"],
  "id" | "name" | "scope" | "provider" | "project_id" | "connection_id" | "amount_minor" | "currency" | "period" | "created_at"
>;

export type BudgetOption = Pick<Budget, "id" | "name" | "amount_minor" | "currency">;

const BUDGET_COLUMNS =
  "id, name, scope, provider, project_id, connection_id, amount_minor, currency, period, created_at" as const;

export const BUDGETS_PAGE_SIZE = 50;
// The budget picker on the rule form; a workspace keeps a few budgets, not hundreds.
const BUDGET_OPTION_LIMIT = 200;
// One row per currency the workspace reports money in: a handful, never hundreds.
const CURRENCY_LIMIT = 200;

/** One page of the workspace's budgets, oldest first. */
export const listBudgets = cache(async (workspaceId: string, after: string | null): Promise<Page<Budget>> => {
  const supabase = await createClient();
  let query = supabase.from("budgets").select(BUDGET_COLUMNS).eq("workspace_id", workspaceId);
  const cursor = decodeCursor(after);
  if (cursor !== null) query = query.or(afterCursorFilter("created_at", cursor));
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(BUDGETS_PAGE_SIZE + 1);
  if (error) throw new Error("Failed to list budgets", { cause: error });
  const items = data.slice(0, BUDGETS_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor: data.length > BUDGETS_PAGE_SIZE && last !== undefined ? encodeCursor([last.created_at, last.id]) : null,
  };
});

/** Every budget (bounded), for the rule form's budget picker and for naming budgets in rule summaries. */
export const listBudgetOptions = cache(async (workspaceId: string): Promise<BudgetOption[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("budgets")
    .select("id, name, amount_minor, currency")
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(BUDGET_OPTION_LIMIT);
  if (error) throw new Error("Failed to list budget options", { cause: error });
  return data;
});

/**
 * ISO 4217 codes of the workspace's money snapshots, sorted: the currency of each series' newest
 * snapshot, read in the database (`snapshot_currencies`), so a currency last reported long before
 * the others is still offered, and a non-member gets none.
 */
export const listSnapshotCurrencies = cache(async (workspaceId: string): Promise<string[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("snapshot_currencies", { p_workspace_id: workspaceId })
    .select("currency")
    .order("currency", { ascending: true })
    .limit(CURRENCY_LIMIT);
  if (error) throw new Error("Failed to list snapshot currencies", { cause: error });
  return data.map((row) => row.currency);
});

/**
 * Spend rows for budget projections (#167): the verified and estimated spend in the dashboard's
 * snapshot window for the whole workspace, joined the way alert evaluation joins them
 * (`joinAlertSnapshots`). Rows of excluded accounts, or of an account that moved connection, are
 * skipped. Call only after `requireWorkspace` has confirmed membership.
 */
export async function getBudgetSpendRows(workspaceId: string, now: Date): Promise<AlertSnapshotInput[]> {
  const [scope, { rows }] = await Promise.all([
    getWorkspaceScope(workspaceId),
    loadSnapshots(workspaceId, snapshotWindowStart(now), "budget projections", { kinds: ["verified_spend", "estimated_spend"] }),
  ]);
  return joinAlertSnapshots(rows, scope.connections, scope.accounts);
}

export async function insertBudget(workspaceId: string, values: BudgetValues): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("budgets").insert({ ...values, workspace_id: workspaceId });
  if (error) throw new Error("Failed to create budget", { cause: error });
}

/** Replaces a budget's settings. False when no budget with `id` exists in this workspace. */
export async function updateBudget(workspaceId: string, id: string, values: BudgetValues): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("budgets")
    .update(values)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error("Failed to update budget", { cause: error });
  return data.length > 0;
}

/** Deletes a budget; its budget percent rules go with it (on delete cascade). */
export async function deleteBudget(workspaceId: string, id: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("budgets")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error("Failed to delete budget", { cause: error });
  return data.length > 0;
}
