import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { API_ENDPOINTS, type ApiEndpoint } from "./endpoints";
import { buildOpenApiDocument } from "./openapi";
import { parseApiQuery } from "./route";
import { API_KEY_SCOPES } from "./scopes";

const ENDPOINTS: readonly ApiEndpoint[] = Object.values(API_ENDPOINTS);
const document = buildOpenApiDocument();

type Operation = (typeof document.paths)[string]["get"];

function operationFor(endpoint: ApiEndpoint): Operation {
  const pathItem = document.paths[endpoint.path];
  if (pathItem === undefined) throw new Error(`${endpoint.path} is missing from the OpenAPI document`);
  return pathItem.get;
}

describe("buildOpenApiDocument", () => {
  it("is an OpenAPI 3.1 document listing exactly the /api/v1 endpoints", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).sort()).toEqual(ENDPOINTS.map((endpoint) => endpoint.path).sort());
  });

  it.each(ENDPOINTS.map((endpoint) => [endpoint.path, endpoint] as const))(
    "documents %s with its scope, every query parameter, and its errors",
    (_path, endpoint) => {
      const operation = operationFor(endpoint);
      expect(operation.security).toEqual([{ apiKey: endpoint.scope === null ? [] : [endpoint.scope] }]);
      expect(operation.parameters.map((parameter) => parameter.name).sort()).toEqual(Object.keys(endpoint.query.shape).sort());
      expect(operation.parameters.every((parameter) => parameter.in === "query" && !parameter.required)).toBe(true);
      expect(Object.keys(operation.responses)).toEqual(
        endpoint.scope === null ? ["200", "400", "401", "429", "500"] : ["200", "400", "401", "403", "429", "500"],
      );
    },
  );

  it("bounds the page size in the published schema", () => {
    const limit = operationFor(API_ENDPOINTS.events).parameters.find((parameter) => parameter.name === "limit");
    expect(limit?.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 100, default: 50 });
  });

  it("serializes to JSON with no JSON Schema dialect lines and no references it cannot resolve", () => {
    const json = JSON.stringify(document);
    expect(json).not.toContain('"$schema"');
    const refs = [...json.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(refs)).toEqual(new Set(["#/components/schemas/Error"]));
  });

  it("never describes a field that would carry a secret", () => {
    expect(JSON.stringify(document)).not.toMatch(/token_hash|granted_scopes|ciphertext|credential_/);
  });
});

describe("docs/api.md", () => {
  const guide = fs.readFileSync(path.join(process.cwd(), "docs", "api.md"), "utf8");
  const examples = [...guide.matchAll(/"\$STACKDASH_URL(\/api\/v1\/[a-z-]+)(\?[^"]*)?"/g)].map((match) => ({
    path: match[1] ?? "",
    query: match[2] ?? "",
  }));

  it("has curl examples", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples.map((example) => [`${example.path}${example.query}`, example] as const))(
    "example %s calls a real endpoint with parameters it accepts",
    (_url, example) => {
      const endpoint = ENDPOINTS.find((candidate) => candidate.path === example.path);
      expect(endpoint, example.path).toBeDefined();
      if (endpoint === undefined) return;
      expect(() => parseApiQuery(new URL(`http://localhost${example.path}${example.query}`), endpoint.query)).not.toThrow();
    },
  );

  it.each(ENDPOINTS.map((endpoint) => endpoint.path))("shows a curl example for %s", (endpointPath) => {
    expect(examples.some((example) => example.path === endpointPath)).toBe(true);
  });

  it.each(API_KEY_SCOPES)("explains the %s scope", (scope) => {
    expect(guide).toContain(`| \`${scope}\` |`);
  });
});
