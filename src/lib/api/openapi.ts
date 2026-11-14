import "server-only";

import { z } from "zod";

import { API_RATE_LIMIT_PER_MINUTE } from "@/lib/api/auth";
import { API_ENDPOINTS, type ApiEndpoint } from "@/lib/api/endpoints";
import { ErrorResponseSchema, listResponseSchema } from "@/lib/api/schemas";

/*
 * The OpenAPI 3.1 document for /api/v1 (#162), generated from the same Zod schemas the handlers
 * validate with and served at /docs/api/openapi.json. OpenAPI 3.1 schema objects are JSON Schema
 * 2020-12, which is what `z.toJSONSchema` emits by default (zod 4, "JSON Schema" docs), so each
 * schema is used as is apart from its `$schema` line. Responses are inlined: nothing is shared
 * through `components.schemas` except the error envelope.
 */

const SECURITY_SCHEME = "apiKey";
const ERROR_REF = { $ref: "#/components/schemas/Error" } as const;

type JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _omitted, ...rest } = z.toJSONSchema(schema, { io: "output" });
  return rest;
}

function errorResponse(description: string) {
  return { description, content: { "application/json": { schema: ERROR_REF } } };
}

function operation(endpoint: ApiEndpoint) {
  const parameters = Object.entries(endpoint.query.shape).map(([name, field]) => ({
    name,
    in: "query",
    required: false,
    ...(field.description === undefined ? {} : { description: field.description }),
    schema: jsonSchema(field),
  }));
  const scopeNote =
    endpoint.scope === null ? "Any working key may call it." : `Needs a key with the ${endpoint.scope} scope.`;
  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: `${endpoint.description} ${scopeNote}`,
    // OpenAPI 3.1 lets a non-OAuth requirement list role names; here they are the key's scopes.
    security: [{ [SECURITY_SCHEME]: endpoint.scope === null ? [] : [endpoint.scope] }],
    parameters,
    responses: {
      "200": {
        description: "One page of results.",
        content: { "application/json": { schema: jsonSchema(listResponseSchema(endpoint.item)) } },
      },
      "400": errorResponse("A query parameter is unknown, repeated, or not valid."),
      "401": errorResponse("The key is missing, malformed, unknown, or revoked."),
      ...(endpoint.scope === null ? {} : { "403": errorResponse(`The key does not have the ${endpoint.scope} scope.`) }),
      "429": errorResponse(`The key made more than ${API_RATE_LIMIT_PER_MINUTE} requests this minute.`),
      "500": errorResponse("Something failed on the server. Quote the reference id."),
    },
  };
}

export function buildOpenApiDocument() {
  const endpoints: readonly ApiEndpoint[] = Object.values(API_ENDPOINTS);
  return {
    openapi: "3.1.0",
    info: {
      title: "StackDash REST API",
      version: "1",
      description:
        "Read-only access to one workspace's usage, events, alerts, and connection status. Create a key in the workspace settings and send it as a bearer token. Guide: /docs/api",
    },
    servers: [{ url: "/", description: "The StackDash instance that serves this document." }],
    security: [{ [SECURITY_SCHEME]: [] }],
    paths: Object.fromEntries(endpoints.map((endpoint) => [endpoint.path, { get: operation(endpoint) }])),
    components: {
      securitySchemes: {
        [SECURITY_SCHEME]: {
          type: "http",
          scheme: "bearer",
          description: "A workspace API key, sd_ followed by 43 characters, from the workspace settings.",
        },
      },
      schemas: { Error: jsonSchema(ErrorResponseSchema) },
    },
  };
}
