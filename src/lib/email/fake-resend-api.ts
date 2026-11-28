import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { z } from "zod";

import { readBoundedChunks } from "@/lib/http/bounded-body";

/*
 * A stand-in for Resend's send email endpoint (#244), for local development, the unit tests of the
 * transport, and the e2e run: the app talks to it through the real `resend` package with
 * STACKDASH_RESEND_API_URL set to its origin, so nothing leaves this computer and no real key is
 * needed. Started by `npm run email:fake` (scripts/fake-resend-api.ts) and by Playwright.
 *
 * What it mirrors from https://resend.com/docs/api-reference/emails/send-email and
 * https://resend.com/docs/api-reference/errors (checked 2026-11-07): `POST /emails` with a bearer
 * key answers `{ id }`; errors are `{ statusCode, name, message }`. A missing key is 401
 * `missing_api_key`, and a wrong one 401 `validation_error` (the sending endpoints' answer for a key
 * that does not exist). A body without the required fields is 422 `missing_required_field`, and one
 * with a field of the wrong shape 400 `validation_error`. The same `Idempotency-Key` with the same
 * body answers the first id again without storing a second message, and with another body is 409
 * `invalid_idempotent_request`. `GET /emails/<id>` answers a stored email with the `message_id`
 * Resend would have given it (https://resend.com/docs/api-reference/emails/retrieve-email, checked
 * 2026-11-28), `<id@fake-resend.localhost>`, or 404 `not_found`, so support chat's per-recipient
 * email threading (#680) runs end to end locally.
 *
 * Not Resend, for tests and local use (loopback only, no key on these routes):
 * - `GET /fake/emails` lists what it accepted, oldest first, as `{ data: FakeEmail[] }`.
 * - `POST /fake/failures` with `{ "status": 429 }` (any 400 to 599, optionally with the error
 *   `"name"`, such as `{ "status": 409, "name": "concurrent_idempotent_requests" }`) or
 *   `{ "hang": true }` queues one answer for the next `POST /emails`: that error, or no answer at
 *   all, for a timeout. Without a name, the status gets the errors page's usual one for it.
 */

// Bounds, so a long running dev session or a looping sender cannot grow it without limit.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STORED = 500;

// The fields the transport sends; unknown fields are dropped. Resend allows at most 50 recipients.
const sendEmailSchema = z.object({
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(50)]),
  subject: z.string().min(1),
  text: z.string().optional(),
  html: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const fakeEmailSchema = z.object({
  id: z.string(),
  /** The Message-ID header Resend would have set, which `GET /emails/<id>` reports. */
  messageId: z.string(),
  receivedAt: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string().nullable(),
  html: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  idempotencyKey: z.string().nullable(),
});

export type FakeEmail = z.infer<typeof fakeEmailSchema>;

export const fakeEmailListSchema = z.object({ data: z.array(fakeEmailSchema) });

const failureSchema = z.union([
  z.object({ status: z.number().int().min(400).max(599), name: z.string().min(1).optional() }).strict(),
  z.object({ hang: z.literal(true) }).strict(),
]);

export type FakeFailure = z.infer<typeof failureSchema>;

export type FakeResendApi = Readonly<{
  /** The origin to set as STACKDASH_RESEND_API_URL, such as http://127.0.0.1:55430. */
  url: string;
  emails(): readonly FakeEmail[];
  /** Queues one answer for the next `POST /emails`, the same as `POST /fake/failures`. */
  failNext(failure: FakeFailure): void;
  close(): Promise<void>;
}>;

export type FakeResendApiOptions = Readonly<{
  apiKey: string;
  /** 0 picks a free port. */
  port: number;
  /** Called for each message stored, after it is stored. */
  onEmail?: (email: FakeEmail) => void;
}>;

// The errors page's name for a status, for a queued failure that names none.
const DEFAULT_ERROR_NAMES: Readonly<Record<number, string>> = {
  400: "validation_error",
  401: "validation_error",
  403: "validation_error",
  404: "not_found",
  405: "method_not_allowed",
  409: "invalid_idempotent_request",
  422: "missing_required_field",
  429: "rate_limit_exceeded",
  500: "application_error",
  503: "service_unavailable",
};

const REQUIRED_FIELDS = ["from", "to", "subject"] as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, name: string, message: string): void {
  sendJson(response, status, { statusCode: status, name, message });
}

class BodyTooLarge extends Error {
  override readonly name = "BodyTooLarge";
}

async function readBody(request: IncomingMessage): Promise<string> {
  // No encoding is set on the request, so it yields Buffers, which are Uint8Arrays.
  const bytes = await readBoundedChunks(request, MAX_BODY_BYTES);
  if (bytes === null) throw new BodyTooLarge(`Request body is over ${MAX_BODY_BYTES} bytes`);
  // Buffer's decoder, not TextDecoder, which would drop a leading byte order mark.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export async function startFakeResendApi(options: FakeResendApiOptions): Promise<FakeResendApi> {
  const stored: FakeEmail[] = [];
  // Idempotency key to the hash of the body it was first used with, and the id it was answered with.
  const idempotent = new Map<string, { bodyHash: string; id: string }>();
  const failures: FakeFailure[] = [];

  function store(email: FakeEmail, bodyHash: string): void {
    stored.push(email);
    if (stored.length > MAX_STORED) stored.shift();
    if (email.idempotencyKey === null) return;
    idempotent.set(email.idempotencyKey, { bodyHash, id: email.id });
    // Maps keep insertion order, so the first key is the oldest.
    const oldest = idempotent.keys().next();
    if (idempotent.size > MAX_STORED && oldest.done !== true) idempotent.delete(oldest.value);
  }

  async function sendEmail(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const failure = failures.shift();
    if (failure !== undefined) {
      // A hung request stays open until the client gives up or the server closes.
      if ("hang" in failure) return;
      const name = failure.name ?? DEFAULT_ERROR_NAMES[failure.status] ?? (failure.status >= 500 ? "application_error" : "validation_error");
      sendError(response, failure.status, name, `Failure queued with POST /fake/failures (${failure.status}).`);
      return;
    }

    const authorization = request.headers.authorization;
    if (authorization === undefined) return sendError(response, 401, "missing_api_key", "Missing API Key");
    if (authorization !== `Bearer ${options.apiKey}`) return sendError(response, 401, "validation_error", "API key is invalid");

    const raw = await readBody(request);
    const json = parseJson(raw);
    const missing = REQUIRED_FIELDS.filter((field) => typeof json !== "object" || json === null || !(field in json));
    if (missing.length > 0) return sendError(response, 422, "missing_required_field", `Missing fields: ${missing.join(", ")}.`);
    const parsed = sendEmailSchema.safeParse(json);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".")))];
      return sendError(response, 400, "validation_error", `Invalid fields: ${fields.join(", ")}.`);
    }

    const keyHeader = request.headers["idempotency-key"];
    const idempotencyKey = typeof keyHeader === "string" && keyHeader !== "" ? keyHeader : null;
    const bodyHash = createHash("sha256").update(raw).digest("hex");
    if (idempotencyKey !== null) {
      const earlier = idempotent.get(idempotencyKey);
      if (earlier !== undefined) {
        if (earlier.bodyHash !== bodyHash) {
          return sendError(response, 409, "invalid_idempotent_request", "Same idempotency key used with a different request payload.");
        }
        return sendJson(response, 200, { id: earlier.id });
      }
    }

    const body = parsed.data;
    const id = randomUUID();
    const email: FakeEmail = {
      id,
      messageId: `<${id}@fake-resend.localhost>`,
      receivedAt: new Date().toISOString(),
      from: body.from,
      to: typeof body.to === "string" ? [body.to] : body.to,
      subject: body.subject,
      text: body.text ?? null,
      html: body.html ?? null,
      headers: body.headers ?? {},
      idempotencyKey,
    };
    store(email, bodyHash);
    options.onEmail?.(email);
    sendJson(response, 200, { id: email.id });
  }

  function retrieveEmail(request: IncomingMessage, response: ServerResponse, id: string): void {
    const authorization = request.headers.authorization;
    if (authorization === undefined) return sendError(response, 401, "missing_api_key", "Missing API Key");
    if (authorization !== `Bearer ${options.apiKey}`) return sendError(response, 401, "validation_error", "API key is invalid");
    const email = stored.find((candidate) => candidate.id === id);
    if (email === undefined) return sendError(response, 404, "not_found", "Email not found");
    sendJson(response, 200, {
      object: "email",
      id: email.id,
      message_id: email.messageId,
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      bcc: null,
      cc: null,
      reply_to: null,
      created_at: email.receivedAt,
      last_event: "delivered",
      scheduled_at: null,
    });
  }

  async function queueFailure(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = failureSchema.safeParse(parseJson(await readBody(request)));
    if (!parsed.success) return sendError(response, 400, "validation_error", 'Send { "status": 400 to 599, "name"?: string } or { "hang": true }.');
    failures.push(parsed.data);
    response.writeHead(204).end();
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    if (request.method === "POST" && path === "/emails") return sendEmail(request, response);
    if (request.method === "GET" && path.startsWith("/emails/")) return retrieveEmail(request, response, path.slice("/emails/".length));
    if (request.method === "GET" && path === "/fake/emails") return sendJson(response, 200, { data: stored });
    if (request.method === "POST" && path === "/fake/failures") return queueFailure(request, response);
    sendError(response, 404, "not_found", "The requested endpoint does not exist.");
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) return response.destroy(error instanceof Error ? error : undefined);
      if (error instanceof BodyTooLarge) return sendError(response, 400, "validation_error", error.message);
      // A defect in the fake itself: answer like Resend's own 500 and keep serving.
      sendError(response, 500, "application_error", error instanceof Error ? error.message : "Fake Resend API failed.");
    });
  });

  // Loopback only: the routes under /fake take no key.
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(options.port, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fake Resend API has no TCP address.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    emails: () => [...stored],
    failNext: (failure) => {
      failures.push(failure);
    },
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error === undefined ? closed.resolve() : closed.reject(error)));
      // A hung request would hold the server open until the client gave up.
      server.closeAllConnections();
      await closed.promise;
    },
  };
}
