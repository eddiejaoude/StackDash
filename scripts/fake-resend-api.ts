/*
 * Runs the fake Resend API (#244) for local development: alert and digest emails go to it instead
 * of Resend, and it prints each one.
 *
 *   npm run email:fake
 *
 * Reads `.env.local` when present: it listens on the port of STACKDASH_RESEND_API_URL, which must be
 * http://127.0.0.1:<port> (http://127.0.0.1:55430 in .env.example), and accepts only
 * STACKDASH_RESEND_API_KEY, the key the app sends. Then `npm run jobs:tick` (or the running app's
 * tick) sends what is due to it. Everything it accepted is at GET <url>/fake/emails, and
 * POST <url>/fake/failures queues an error answer; see src/lib/email/fake-resend-api.ts. Stops on
 * Ctrl+C or SIGTERM and keeps nothing.
 */
import { existsSync } from "node:fs";

import { startFakeResendApi, type FakeEmail } from "@/lib/email/fake-resend-api";
import { emailEnv } from "@/lib/env";

function print(email: FakeEmail): void {
  console.log(`\n${email.receivedAt} ${email.id}\nTo: ${email.to.join(", ")}\nSubject: ${email.subject}\n\n${email.text ?? "(no text part)"}`);
}

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const env = emailEnv();
  if (env === null) {
    console.error("Set STACKDASH_EMAIL_FROM, STACKDASH_RESEND_API_KEY (any value), and STACKDASH_RESEND_API_URL=http://127.0.0.1:55430 in .env.local, as in .env.example.");
    process.exitCode = 2;
    return;
  }
  const url = new URL(env.apiUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "") {
    console.error("STACKDASH_RESEND_API_URL is not http://127.0.0.1:<port>, where the fake listens, so the app would not send to it. Use http://127.0.0.1:55430, as in .env.example.");
    process.exitCode = 2;
    return;
  }

  const api = await startFakeResendApi({ apiKey: env.apiKey, port: Number(url.port), onEmail: print });
  console.log(`Fake Resend API at ${api.url}. Sent emails: ${api.url}/fake/emails. Ctrl+C stops it.`);

  const stopped = Promise.withResolvers<void>();
  process.once("SIGINT", () => stopped.resolve());
  process.once("SIGTERM", () => stopped.resolve());
  await stopped.promise;
  await api.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The fake Resend API failed.");
  process.exitCode = 1;
});
