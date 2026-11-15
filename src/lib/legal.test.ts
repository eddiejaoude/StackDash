import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import PrivacyPage, { generateMetadata as privacyMetadata } from "@/app/privacy/page";
import TermsPage, { generateMetadata as termsMetadata } from "@/app/terms/page";
import { LegalConsent } from "@/components/legal/legal-consent";
import { LegalDocument } from "@/components/legal/legal-document";
import { SiteFooter } from "@/components/site-footer";

import { legalLinks, legalPages, PRIVACY_UPDATED, requireOperator, TERMS_UPDATED } from "./legal";

// Synthetic, and deliberately not the hosted instance's values: the text must come from here.
const OPERATOR = {
  STACKDASH_OPERATOR_NAME: "Example Operator Ltd",
  STACKDASH_OPERATOR_EMAIL: "privacy@example.com",
  STACKDASH_GOVERNING_LAW: "Scotland",
} as const;

function stubOperator(values: Partial<Record<keyof typeof OPERATOR, string>>): void {
  for (const name of Object.keys(OPERATOR) as (keyof typeof OPERATOR)[]) vi.stubEnv(name, values[name] ?? "");
}

/** Where this instance runs, and where it sends alert email (`false`: email is not set up). */
type Hosting = { vercel: boolean; email: false | { apiUrl: string } };

/**
 * Stubs the variables that decide the processors the policy names. `email.apiUrl` is
 * STACKDASH_RESEND_API_URL, where "" leaves it unset (Resend's own API).
 */
function stubHosting({ vercel, email }: Hosting): void {
  vi.stubEnv("VERCEL", vercel ? "1" : "");
  vi.stubEnv("STACKDASH_RESEND_API_KEY", email ? "test-key" : "");
  vi.stubEnv("STACKDASH_RESEND_API_URL", email ? email.apiUrl : "");
  vi.stubEnv("STACKDASH_EMAIL_FROM", email ? "StackDash <alerts@example.com>" : "");
}

// Resend's own API, by default and spelled out; another server that answers like it; the local fake.
const RESEND = { apiUrl: "" };
const RESEND_EXPLICIT = { apiUrl: "https://api.resend.com/" };
const RELAY = { apiUrl: "https://mail.example.com" };
const LOCAL_FAKE = { apiUrl: "http://127.0.0.1:55430" };

/** What `fn` threw; fails the test when it returned instead. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw, but the call returned.");
}

// notFound() throws this digest (node_modules/next/dist/client/components/http-access-fallback).
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with an operator configured", () => {
  it("the privacy policy names the operator and its contact address, and links each provider page", () => {
    stubOperator(OPERATOR);
    stubHosting({ vercel: false, email: false });
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    expect(html).toContain("<h1");
    expect(html).toContain("Example Operator Ltd runs StackDash at this address");
    expect(html).toContain('href="mailto:privacy@example.com"');
    expect(html).toContain('href="/docs/providers/stripe"');
    expect(html).toContain('href="/docs/providers/vercel"');
    expect(privacyMetadata()).toMatchObject({ title: "Privacy policy" });
  });

  it("the terms of use name the operator, its contact address, and the governing law", () => {
    stubOperator(OPERATOR);
    const html = renderToStaticMarkup(createElement(TermsPage));

    expect(html).toContain("which Example Operator Ltd runs");
    expect(html).toContain('href="mailto:privacy@example.com"');
    expect(html).toContain("governed by the law of Scotland");
    expect(html).not.toContain("England");
    expect(termsMetadata()).toMatchObject({ title: "Terms of use" });
  });

  it.each<[string, Hosting, string[], string[]]>([
    ["on Vercel with alert email", { vercel: true, email: RESEND }, ["Vercel", "Vercel Web Analytics", "Resend"], ["Hosting", "Email"]],
    ["on Vercel without alert email", { vercel: true, email: false }, ["Vercel", "Vercel Web Analytics"], ["Hosting", "Resend", "Email"]],
    ["self-hosted with alert email", { vercel: false, email: RESEND }, ["Hosting", "Resend"], ["Vercel", "Vercel Web Analytics", "Email"]],
    ["self-hosted without alert email", { vercel: false, email: false }, ["Hosting"], ["Vercel", "Vercel Web Analytics", "Resend", "Email"]],
    ["with Resend's API set explicitly", { vercel: false, email: RESEND_EXPLICIT }, ["Resend"], ["Email"]],
    ["sending through another server", { vercel: false, email: RELAY }, ["Email"], ["Resend"]],
    ["sending to the local fake", { vercel: false, email: LOCAL_FAKE }, ["Email"], ["Resend"]],
  ])("the privacy policy names only the processors an instance %s uses", (_title, hosting, named, absent) => {
    stubOperator(OPERATOR);
    stubHosting(hosting);
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    for (const processor of ["Supabase", "GitHub", ...named]) expect(html).toContain(`<strong>${processor}</strong>`);
    for (const processor of absent) expect(html).not.toContain(`<strong>${processor}</strong>`);
  });

  it.each([
    ["on Vercel, the policy describes the page view counts the root layout loads", true],
    ["self-hosted, the policy says no analytics run, because the root layout loads none", false],
  ])("%s", (_title, vercel) => {
    stubOperator(OPERATOR);
    stubHosting({ vercel, email: false });
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    const counted = [
      "counts page views with Vercel Web Analytics, which sets no cookies",
      "includes the workspace handle",
      "Page view counts: Vercel keeps them",
    ];
    for (const statement of counted) expect(html.includes(statement)).toBe(vercel);
    expect(html.includes("runs no analytics, advertising, or tracking scripts")).toBe(!vercel);
  });

  it.each<[string, Hosting["email"], boolean]>([
    ["alert email through Resend", RESEND, true],
    ["alert email through another server", RELAY, true],
    ["no alert email", false, false],
  ])("with %s, the policy says whether the email service keeps sent mail after deletion", (_title, email, kept) => {
    stubOperator(OPERATOR);
    stubHosting({ vercel: false, email });
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    const statements = [
      "Alert and digest emails already sent: the email service keeps its record of them",
      "also keeps its own record of the emails it already sent",
    ];
    for (const statement of statements) expect(html.includes(statement)).toBe(kept);
    expect(html).toContain("Two records in our database that hold your email address stay");
  });

  it.each([
    ["the privacy policy", () => privacyMetadata(), "/privacy", "Privacy policy"],
    ["the terms of use", () => termsMetadata(), "/terms", "Terms of use"],
  ])("%s has its own canonical address and preview cards", (_title, metadata, path, title) => {
    stubOperator(OPERATOR);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stackdash.example");

    expect(metadata()).toMatchObject({
      title,
      alternates: { canonical: path },
      openGraph: { title, url: path },
      twitter: { card: "summary_large_image", title },
    });
  });

  it("each page shows its own date, and the sitemap sends the same one", () => {
    stubOperator(OPERATOR);
    stubHosting({ vercel: false, email: false });

    expect(renderToStaticMarkup(createElement(PrivacyPage))).toContain(`<time dateTime="${PRIVACY_UPDATED}">`);
    expect(renderToStaticMarkup(createElement(TermsPage))).toContain(`<time dateTime="${TERMS_UPDATED}">`);
    // The shell shows the date it is given, so a change to one document never moves the other's.
    const shell = renderToStaticMarkup(LegalDocument({ title: "Terms of use", updated: "2027-01-02", intro: "", children: null }));
    expect(shell).toContain('<time dateTime="2027-01-02">2027-01-02</time>');
    expect(legalPages().map(({ link, updated }) => [link.href, updated])).toEqual([
      ["/privacy", PRIVACY_UPDATED],
      ["/terms", TERMS_UPDATED],
    ]);
  });

  it("the footer, the sign-in line, and the sitemap links lead to both pages", () => {
    stubOperator(OPERATOR);
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    const consent = renderToStaticMarkup(createElement(LegalConsent));

    for (const html of [footer, consent]) {
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
    }
    expect(consent).toContain("By continuing, you agree to the");
    expect(legalLinks().map((link) => link.href)).toEqual(["/privacy", "/terms"]);
    expect(requireOperator()).toEqual({
      name: "Example Operator Ltd",
      email: "privacy@example.com",
      governingLaw: "Scotland",
    });
  });
});

describe("with no operator configured", () => {
  it.each([
    ["the privacy policy", () => PrivacyPage()],
    ["the privacy policy's metadata", () => privacyMetadata()],
    ["the terms of use", () => TermsPage()],
    ["the terms of use's metadata", () => termsMetadata()],
  ])("%s answers 404", (_title, render) => {
    stubOperator({});
    expect(thrownBy(render)).toMatchObject(NOT_FOUND);
  });

  it("the footer, the sign-in line, and the sitemap links leave both pages out", () => {
    stubOperator({});
    const footer = renderToStaticMarkup(createElement(SiteFooter));

    expect(footer).toContain('href="/sign-in"');
    expect(footer).not.toContain('href="/privacy"');
    expect(footer).not.toContain('href="/terms"');
    expect(renderToStaticMarkup(createElement(LegalConsent))).toBe("");
    expect(legalLinks()).toEqual([]);
    expect(legalPages()).toEqual([]);
  });

  it("a partial configuration fails loudly instead of rendering a page with no contact", () => {
    stubOperator({ STACKDASH_OPERATOR_NAME: OPERATOR.STACKDASH_OPERATOR_NAME });
    expect(() => requireOperator()).toThrow(/STACKDASH_OPERATOR_EMAIL is not set; STACKDASH_GOVERNING_LAW is not set/);
  });
});
