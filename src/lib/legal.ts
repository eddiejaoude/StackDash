import "server-only";

import { notFound } from "next/navigation";

import { operatorEnv, type OperatorEnv } from "@/lib/env";
import { privacyLink, termsLink, type NavLink } from "@/lib/site";

/*
 * The privacy policy and terms of use (#339) name whoever runs this instance, from server
 * configuration. An instance that names no operator publishes neither page and links to neither,
 * so a self-hosted copy never presents another operator's policy as its own.
 */

/** When the privacy policy last changed. Change it with every edit to its text, and only then. */
export const PRIVACY_UPDATED = "2026-11-15";

/** When the terms of use last changed. Change it with every edit to their text, and only then. */
export const TERMS_UPDATED = "2026-11-12";

/** A legal page and the date its text last changed, which the page shows and the sitemap sends. */
export type LegalPage = Readonly<{ link: NavLink; updated: string }>;

/** The configured operator, or a 404 for an instance that names none. */
export function requireOperator(): OperatorEnv {
  const operator = operatorEnv();
  if (operator === null) notFound();
  return operator;
}

/** Both pages with their dates, or none when the instance names no operator. */
export function legalPages(): readonly LegalPage[] {
  if (operatorEnv() === null) return [];
  return [
    { link: privacyLink, updated: PRIVACY_UPDATED },
    { link: termsLink, updated: TERMS_UPDATED },
  ];
}

/** The links to both pages, or none when the instance names no operator. */
export function legalLinks(): readonly NavLink[] {
  return legalPages().map((page) => page.link);
}
