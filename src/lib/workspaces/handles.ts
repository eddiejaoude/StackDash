import { z } from "zod";

/*
 * Workspace handles (#258): the readable name a workspace can claim for its public project page
 * addresses, `/@<handle>/<page>`. Client-safe: no data access. The settings form (hints), the
 * Server Action (validation), and the proxy (address parsing) all read these rules. The database
 * enforces the same format and length in workspaces_handle_format and uniqueness in
 * workspaces_handle_key (20261111090000_workspace_handles.sql); the reserved list lives only here,
 * because the only write path, set_workspace_handle(), is reached through the Server Action.
 *
 * Rules decided on the issue: 3 to 32 characters, lowercase a to z and 0 to 9 with single hyphens
 * between them, trimmed and lowercased before checking, reserved words refused. A handle can
 * change; the old one is released at once and is not redirected.
 */

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
const HANDLE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Refused as handles. Every top-level route segment of the app comes first (handles.test.ts keeps
 * that part in step with src/app), so a handle can never be mistaken for a page of StackDash if
 * addresses ever drop the `@`. Then segments and root files the app is likely to add, and names a
 * visitor could take for StackDash itself. Entries shorter than HANDLE_MIN are refused by length
 * already; they stay listed so the route list is complete.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Top-level route segments under src/app.
  "account",
  "api",
  "app",
  "auth",
  "badge",
  "card",
  "docs",
  "oauth",
  "p",
  "sign-in",
  "super-admin",
  "unsubscribe",
  "w",
  // Root files and segments the app serves or is likely to add.
  "about",
  "admin",
  "assets",
  "billing",
  "blog",
  "dashboard",
  "favicon",
  "icon",
  "login",
  "logout",
  "manifest",
  "pricing",
  "privacy",
  "public",
  "robots",
  "security",
  "settings",
  "sign-out",
  "sign-up",
  "signin",
  "signup",
  "sitemap",
  "static",
  "status",
  "terms",
  // StackDash itself, and names a visitor could take for it.
  "stackdash",
  "help",
  "official",
  "root",
  "staff",
  "support",
  "system",
  "team",
  "www",
]);

/**
 * Trims, then lowercases A to Z only. Any other character is left as typed so the format check
 * refuses it: `toLowerCase()` would turn the Kelvin sign into an ASCII `k` and accept it.
 */
export function normalizeHandle(input: string): string {
  return input.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Length and characters only, for parsing addresses. Reserved words pass: nobody can hold one. */
export function isHandleFormat(value: string): boolean {
  return value.length >= HANDLE_MIN && value.length <= HANDLE_MAX && HANDLE_PATTERN.test(value);
}

export const handleSchema = z
  .string()
  .overwrite(normalizeHandle)
  .min(1, "Enter a handle, such as acme-labs.")
  .min(HANDLE_MIN, `Use at least ${HANDLE_MIN} characters.`)
  .max(HANDLE_MAX, `Use ${HANDLE_MAX} characters or fewer.`)
  .regex(HANDLE_PATTERN, "Use lowercase letters and numbers, with single hyphens between words.")
  .refine((handle) => !RESERVED_HANDLES.has(handle), "This handle is reserved. Choose another one.");
