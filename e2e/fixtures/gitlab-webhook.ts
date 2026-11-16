import { randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { GITLAB_TOKEN_HEADER } from "../../src/lib/adapters/gitlab";

/*
 * GitLab project webhook deliveries for end-to-end runs (#428), shaped like GitLab's documented
 * "Pipeline events" payload (https://docs.gitlab.com/user/project/integrations/webhook_events/),
 * trimmed, with synthetic values. The simulated GitLab provider runs the live adapter's `verify`
 * and `parse`, so these go through the real code: the secret token in `X-Gitlab-Token`, the
 * delivery id in `webhook-id`, and the project's top-level namespace matched to the connection's
 * account by path. The simulated group is `example-group` (src/lib/adapters/simulated/gitlab.ts).
 */

export const SIMULATED_GITLAB_GROUP = "example-group";

export type PipelineDelivery = Readonly<{
  projectId: number;
  projectPath: string;
  pipelineId: number;
  status: "success" | "failed" | "running";
  ref?: string;
}>;

/** The iid a delivery of `pipelineId` carries: GitLab's iids are per project and start at 1. */
export function pipelineIid(pipelineId: number): number {
  return (pipelineId % 1000) + 1;
}

/** A `Pipeline Hook` body for one finished (or running) pipeline. */
export function pipelineDeliveryBody({ projectId, projectPath, pipelineId, status, ref = "main" }: PipelineDelivery): string {
  return JSON.stringify({
    object_kind: "pipeline",
    object_attributes: {
      id: pipelineId,
      iid: pipelineIid(pipelineId),
      ref,
      status,
      created_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: status === "running" ? null : new Date().toISOString(),
      url: `https://gitlab.com/${projectPath}/-/pipelines/${pipelineId}`,
    },
    user: { id: 1, name: "Example User", username: "example_user", email: "user@example.com" },
    project: { id: projectId, name: projectPath.split("/").at(-1), path_with_namespace: projectPath, default_branch: "main" },
  });
}

/**
 * POSTs `body` to the connection's webhook URL as GitLab sends it: the secret token in
 * `X-Gitlab-Token` (none when `token` is null) and a delivery id in `webhook-id`.
 */
export function postGitLabDelivery(
  request: APIRequestContext,
  url: string,
  token: string | null,
  body: string,
  deliveryId: string = randomUUID(),
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Gitlab-Event": "Pipeline Hook",
    "webhook-id": deliveryId,
  };
  if (token !== null) headers[GITLAB_TOKEN_HEADER] = token;
  return request.post(new URL(url).pathname, { data: body, headers });
}
