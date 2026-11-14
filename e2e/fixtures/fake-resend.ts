import { fakeEmailListSchema, type FakeEmail } from "../../src/lib/email/fake-resend-api";

/*
 * The fake Resend API the e2e run sends alert email to (#244). playwright.config.ts starts it as a
 * web server and gives the app these values, which take precedence over .env.local, so a real key
 * there is never used and no email leaves this computer. The key is a dummy, not a secret.
 * E2E_RESEND_PORT sets the port; by default it is the app's port (E2E_PORT, 3100) plus one, so a
 * run on another port does not share it.
 */
const appPort = Number(process.env.E2E_PORT ?? 3100);

export const FAKE_RESEND = {
  url: `http://127.0.0.1:${Number(process.env.E2E_RESEND_PORT ?? appPort + 1)}`,
  apiKey: "fake-resend-e2e-key",
  from: "StackDash alerts <alerts@example.com>",
} as const;

/** Every email the fake accepted since it started, oldest first. */
export async function fakeEmails(): Promise<FakeEmail[]> {
  const response = await fetch(`${FAKE_RESEND.url}/fake/emails`);
  if (!response.ok) throw new Error(`The fake Resend API answered ${response.status}.`);
  return fakeEmailListSchema.parse(await response.json()).data;
}
