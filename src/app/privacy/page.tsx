import type { Metadata } from "next";

import { LegalCode, LegalDocument, LegalLink, LegalSection } from "@/components/legal/legal-document";
import { listDocs } from "@/lib/docs";
import { emailEnv, onVercel, RESEND_API_URL } from "@/lib/env";
import { PRIVACY_UPDATED, requireOperator } from "@/lib/legal";
import { privacyLink, site } from "@/lib/site";
import { socialMetadata } from "@/lib/site-metadata";

/*
 * The privacy policy (#339). Every statement about data describes what the code does; the pull
 * request that changes this text lists the code path behind each one, and so must the next. The
 * operator comes from server configuration (`operatorEnv`), and an instance without one answers 404.
 * The processors follow this instance's own configuration too: Vercel and its Web Analytics only on
 * Vercel (`onVercel`, the same check that renders `WebAnalytics` in the root documents),
 * Resend only where alert email goes to Resend's own API (`emailEnv`), so a self-hosted copy never
 * lists a service it does not use.
 *
 * Prerendered: the text, the operator, the processors, and the provider list from docs/ are all
 * known at build time. 'navigation' makes the build fail if the page ever needs request-time
 * rendering (node_modules/next/dist/docs/01-app/02-guides/keeping-pages-static.md).
 */
export const ensureStatic = "navigation";

const description = `What ${site.name} collects, why, where it is kept, who processes it, and how to delete it.`;

export function generateMetadata(): Metadata {
  requireOperator();
  return {
    title: "Privacy policy",
    description,
    ...socialMetadata({ title: "Privacy policy", description, path: privacyLink.href }),
  };
}

// What the request and server logs hold, wherever the app is hosted.
const LOGS = "Our logs record what happened and a reference id, with tokens, keys, and other secrets masked.";

// Who receives alert email: Resend by name when the client posts to its own API, otherwise whichever
// server STACKDASH_RESEND_API_URL names, which this page cannot name.
function emailProcessor(): "resend" | "other" | null {
  const email = emailEnv();
  if (email === null) return null;
  return email.apiUrl === RESEND_API_URL ? "resend" : "other";
}

export default function PrivacyPage() {
  const operator = requireOperator();
  const email = emailProcessor();
  const providers = listDocs().filter((doc) => doc.group === "providers");
  const contact = <LegalLink href={`mailto:${operator.email}`}>{operator.email}</LegalLink>;

  return (
    <LegalDocument
      title="Privacy policy"
      updated={PRIVACY_UPDATED}
      intro={
        <>
          {operator.name} runs {site.name} at this address and is responsible for the personal data it holds. This
          policy says what {site.name} collects, why, where it is kept, who processes it for us, and how to have it
          deleted. {site.name} is open source and anyone can run their own copy: this policy covers only this one.
          Questions and requests go to {contact}.
        </>
      }
    >
      <LegalSection id="sign-in" title="What we collect when you sign in">
        <p>
          You sign in with GitHub. {site.name} asks GitHub for the <LegalCode>read:user</LegalCode> and{" "}
          <LegalCode>user:email</LegalCode> permissions: read access to your profile and to your email addresses.
          Signing in gives {site.name} no access to your repositories.
        </p>
        <ul>
          <li>
            Your account holds your email address and the GitHub details GitHub returns at each sign-in: your GitHub
            user id, username, display name, and avatar address.
          </li>
          <li>
            {site.name} creates a profile with your display name and a personal workspace for you, and remembers the
            workspace you last opened.
          </li>
          <li>
            While {site.name} is invite only, your email address is checked against the list of invited email
            addresses before your account is created. An address that is not on the list gets no account. Your address
            stays on the list until we remove it, including after you delete your account.
          </li>
          <li>
            Supabase Auth keeps a record of each session you are signed in on, with the IP address and browser details
            of the most recent request that signed you in or renewed the session. That request comes from your browser
            or from the server that runs {site.name} on your behalf, so the record holds the address and details of
            one or the other. Signing out deletes the record of that session.
          </li>
          <li>
            Supabase Auth also keeps a log of sign-in events, such as signing up, signing in, renewing a session,
            signing out, and deleting an account. Each entry names your email address.
          </li>
          <li>Your avatar image loads from GitHub, so GitHub sees that your browser asked for it.</li>
        </ul>
      </LegalSection>

      <LegalSection id="connected-services" title="What we collect from the services you connect">
        <p>
          When you connect a service, {site.name} keeps the access token or key the service gives it. Tokens are
          encrypted on the server with AES-256-GCM before they are stored, are never sent to your browser, and are
          never written to logs. Disconnecting a service deletes its token.
        </p>
        <p>
          {site.name} then reads the service on a schedule and stores daily usage and spend figures and timeline
          events in your workspace. What it reads from each service, and the permissions it asks for, is on that
          service&apos;s page:
        </p>
        <ul>
          {providers.map((doc) => (
            <li key={doc.href}>
              <LegalLink href={doc.href}>{doc.title}</LegalLink>
            </li>
          ))}
        </ul>
        <p>
          Some services can only grant access that includes personal data about your own customers or users, such as
          Stripe and Polar customer records and Supabase auth logs. {site.name} drops that data as soon as it reads a
          response and keeps only amounts, currencies, counts, dates, statuses, and the service&apos;s own ids. It
          never stores your customers&apos; names, email addresses, postal addresses, or card details.
        </p>
      </LegalSection>

      <LegalSection id="alerts" title="Alerts, email, and API keys">
        <ul>
          <li>
            Alert and digest emails go to the email address on your account, when you are an owner or admin of the
            workspace and your alert email setting is on. Every email carries a link that turns them off.
          </li>
          <li>
            Owners and admins can send alerts to Slack, Discord, or a webhook. The address of each channel is stored
            encrypted, and alert messages about the workspace are posted to it.
          </li>
          <li>
            Owners and admins can create API keys for the REST API and the MCP server. {site.name} stores only a hash
            of each key. The key itself is shown once, when it is created.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="public" title="What becomes public">
        <p>
          Nothing in a workspace is public until an owner or admin publishes it. Publishing a metric for a project
          makes its value readable by anyone as a badge, a card, JSON, or a public project page, and a project page
          address shows the workspace handle. Spend, budgets, and alert thresholds cannot be published. Unpublishing
          a metric or turning a page off removes it from public view.
        </p>
        <ul>
          <li>
            To limit how often one visitor can load public pages and images, {site.name} stores a keyed hash of the
            visitor&apos;s IP address for each minute, never the address itself, and deletes it after one day.
          </li>
          <li>
            {site.name} counts how many times each published badge or card image was served each day, without
            recording who asked for it.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="cookies" title="Cookies">
        <p>
          {site.name} uses cookies only to sign you in and keep you signed in. Supabase Auth sets them, and their
          names start with <LegalCode>sb-</LegalCode>: your session, and while sign-in is in progress, a code that
          proves the sign-in started in your browser. Signing out or deleting your account removes them. The home
          page, the docs, these legal pages, and public project pages, badges, and cards set no cookies.
        </p>
        {onVercel() ? (
          <p>
            {site.name} counts page views with Vercel Web Analytics, which sets no cookies. For each page you open, it
            records the page address without anything after a <LegalCode>?</LegalCode> or <LegalCode>#</LegalCode>,
            so the address of a page inside a workspace includes the workspace handle. With it, Vercel records your
            country, region, and city, which it works out from your IP address, and your browser, operating system,
            and type of device. When you arrive from another site, it also records the address of the page that linked
            you here, as much of it as your browser reports. Vercel tells one visitor from another by a hash of the
            request and discards that hash after 24 hours. {site.name} runs no advertising or other tracking scripts,
            and serves its fonts itself, so your browser sends no requests to a font service.
          </p>
        ) : (
          <p>
            {site.name} runs no analytics, advertising, or tracking scripts, and serves its fonts itself, so your
            browser sends no requests to a font service.
          </p>
        )}
      </LegalSection>

      <LegalSection id="processors" title="Who processes data for us">
        <p>These services run parts of {site.name} and process data on our behalf, each under its own terms:</p>
        <ul>
          <li>
            <strong>Supabase</strong>: the database that holds everything above, sign-in, and live updates in the app.
          </li>
          {onVercel() ? (
            <>
              <li>
                <strong>Vercel</strong>: hosts the app and keeps its request and server logs. {LOGS}
              </li>
              <li>
                <strong>Vercel Web Analytics</strong>: counts page views, as the cookies section above describes.
              </li>
            </>
          ) : (
            <li>
              <strong>Hosting</strong>: the servers that run the app keep its request and server logs. {LOGS}
            </li>
          )}
          <li>
            <strong>GitHub</strong>: confirms who you are when you sign in, and serves your avatar.
          </li>
          {email === "resend" && (
            <li>
              <strong>Resend</strong>: sends alert and digest emails, so it receives your email address and the
              message.
            </li>
          )}
          {email === "other" && (
            <li>
              <strong>Email</strong>: the service that sends alert and digest emails receives your email address and
              the message.
            </li>
          )}
        </ul>
        <p>
          The services you connect are yours, not our processors: {site.name} reads from them with the access you
          grant, and you can remove that access at any time.
        </p>
      </LegalSection>

      <LegalSection id="retention" title="How long we keep it">
        <ul>
          <li>Daily usage and spend figures and timeline events: 13 months.</li>
          <li>Records of finished syncs and of sent digests: 30 days.</li>
          <li>Counts of served badge and card images: 13 months.</li>
          {onVercel() && <li>Page view counts: Vercel keeps them for the period its service sets.</li>}
          <li>Hashed visitor addresses for rate limits: one day.</li>
          <li>A connect attempt you did not finish: until it expires, then the next daily cleanup deletes it.</li>
          <li>Triggered alerts: for as long as the alert rule that raised them exists.</li>
          <li>Your account, workspaces, connections, and settings: until you delete them.</li>
          <li>The record of a signed-in session: until you sign out of it or delete your account.</li>
          <li>
            Your email address on the invite list: until we remove it. Deleting your account does not remove it.
          </li>
          <li>
            The log of sign-in events: Supabase keeps it in its own logs for the period its service sets. Any copy in
            the database stays until we delete it: nothing in {site.name} deletes it, and deleting your account does
            not.
          </li>
          {email !== null && (
            <li>
              Alert and digest emails already sent: the email service keeps its record of them for the period its
              service sets. Deleting your account does not remove them.
            </li>
          )}
        </ul>
      </LegalSection>

      <LegalSection id="delete" title="Deleting your account">
        <p>
          You can delete your account at any time on the <LegalLink href="/account">account page</LegalLink>. Deleting
          it removes your sign-in, every signed-in session, your profile, the metrics you published, and every
          workspace only you belong to, with its connections, tokens, and history. Before deleting a connection,{" "}
          {site.name} asks the service to revoke its access where the service allows that, and then lists any service
          where you need to remove the access yourself. If you are the only owner of a workspace other people belong
          to, transfer ownership or delete that workspace first.
        </p>
        <p>
          Two records in our database that hold your email address stay after you delete your account: your entry on
          the invite list, and the log of sign-in events. To have them removed from the database, email {contact}.
          {email !== null && (
            <>
              {" "}
              The service that sends alert and digest emails also keeps its own record of the emails it already sent
              you, as the list above says.
            </>
          )}
        </p>
      </LegalSection>

      <LegalSection id="requests" title="Your requests">
        <p>
          To ask what data we hold about you, for a copy of it, or for it to be corrected or deleted, email {contact}.
          We answer from that address.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="Changes to this policy">
        <p>
          When this policy changes, the date at the top changes with it. The current version is always at this
          address.
        </p>
      </LegalSection>
    </LegalDocument>
  );
}
