import "server-only";

import type { ApiErrorCode, ErrorResponse } from "@/lib/api/schemas";
import { log, logError, type LogFields } from "@/lib/log/logger";
import { newReferenceId } from "@/lib/log/reference";

/*
 * The public API's error contract (#162). Every non-2xx answer from /api/v1 is the same envelope,
 * `{ "error": { "code", "message", "reference_id" } }`, with a fixed set of codes so clients branch
 * on `code`. The message says what to do next and never carries internals; the detail is logged
 * against the same reference id, as the house error rule asks.
 */

const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;
  /** Logged with the reference id; never sent to the client. */
  readonly logFields: LogFields;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { headers?: Record<string, string>; logFields?: LogFields } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.headers = options.headers ?? {};
    this.logFields = options.logFields ?? {};
  }
}

/** 401. The same answer for a missing, malformed, unknown, or revoked key, so it is no oracle. */
export function unauthorized(reason: string, logFields: LogFields = {}): ApiError {
  return new ApiError("unauthorized", "The API key is missing or no longer works. Send a working key as a bearer token.", {
    // RFC 6750, section 3: a 401 names the scheme the client should use.
    headers: { "WWW-Authenticate": 'Bearer realm="stackdash"' },
    logFields: { ...logFields, reason },
  });
}

export function forbidden(scope: string, logFields: LogFields = {}): ApiError {
  return new ApiError(
    "forbidden",
    `This API key cannot read this resource because it does not have the ${scope} scope. Create a key with that scope in the workspace settings.`,
    { logFields: { ...logFields, scope } },
  );
}

export function invalidRequest(message: string): ApiError {
  return new ApiError("invalid_request", message);
}

export const INTERNAL_ERROR_MESSAGE =
  "The request could not be completed. Try again in a moment, and quote the reference id if it keeps failing.";

/**
 * Logs anything an API or MCP handler threw and returns what the caller may see. An ApiError keeps
 * its code, message, and headers and is logged as a warning (it was handled); anything else is a
 * defect, logged with its stack as an error, and replaced by a generic internal error.
 */
export function reportApiError(error: unknown): { apiError: ApiError; referenceId: string } {
  if (error instanceof ApiError) {
    const referenceId = newReferenceId();
    log.warn(`api.${error.code}`, { ...error.logFields, referenceId });
    return { apiError: error, referenceId };
  }
  return { apiError: new ApiError("internal", INTERNAL_ERROR_MESSAGE), referenceId: logError("api.internal_error", error) };
}

/** The error envelope for anything a handler threw, with the status its code maps to. */
export function apiErrorResponse(error: unknown, headers: Readonly<Record<string, string>>): Response {
  const { apiError, referenceId } = reportApiError(error);
  const body: ErrorResponse = {
    error: { code: apiError.code, message: apiError.message, reference_id: referenceId },
  };
  return Response.json(body, {
    status: API_ERROR_STATUS[apiError.code],
    headers: { ...headers, ...apiError.headers },
  });
}
