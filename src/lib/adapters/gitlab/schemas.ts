import { z } from "zod";

/**
 * Response schemas for the GitLab.com REST and GraphQL APIs, from docs/providers/gitlab.md
 * ("Sample responses"). `z.object` drops unknown fields, so author names, emails, avatars, and
 * commit messages in these responses never reach the adapter.
 */

// GitLab timestamps carry `Z` or an offset (`2016-08-11T11:32:35.169Z`, `2016-08-11T09:36:01.000+02:00`).
const isoDateTime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

// https://docs.gitlab.com/api/oauth2/ (checked 2026-11-05). The documented examples carry no
// `scope`; Doorkeeper adds it, so it is optional and the requested scopes stand in when absent.
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// `GET /user` (read_user). Only the id and username are kept.
export const UserSchema = z.object({
  id: z.int().positive(),
  username: z.string().min(1),
});

const NamespaceKindSchema = z.enum(["user", "group"]);

// `GET /namespaces` and `GET /namespaces/:id`.
export const NamespaceSchema = z.object({
  id: z.int().positive(),
  path: z.string().min(1),
  kind: NamespaceKindSchema,
  full_path: z.string().min(1),
  parent_id: z.int().positive().nullable(),
  // A string rather than an enum so a new plan name does not fail the whole sync.
  plan: z.string().min(1).nullable().optional(),
});
export type Namespace = z.infer<typeof NamespaceSchema>;
export const NamespacesSchema = z.array(NamespaceSchema);

// `GET /groups/:id/projects?simple=true` and `GET /users/:user_id/projects?simple=true`.
export const ProjectSchema = z.object({
  id: z.int().positive(),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().min(1).nullable().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
export const ProjectsSchema = z.array(ProjectSchema);

// `GET /projects/:id/pipelines`. `updated_at` is the closest the list gives to when it finished.
export const PipelineSchema = z.object({
  id: z.int().positive(),
  iid: z.int().positive(),
  status: z.string().min(1),
  ref: z.string().min(1),
  web_url: z.string().min(1),
  updated_at: isoDateTime,
});
export type Pipeline = z.infer<typeof PipelineSchema>;
export const PipelinesSchema = z.array(PipelineSchema);

// `GET /projects/:id/deployments`.
export const DeploymentSchema = z.object({
  id: z.int().positive(),
  iid: z.int().positive(),
  status: z.string().min(1),
  ref: z.string().min(1),
  updated_at: isoDateTime,
  environment: z.object({ id: z.int().positive(), name: z.string().min(1) }),
});
export type Deployment = z.infer<typeof DeploymentSchema>;
export const DeploymentsSchema = z.array(DeploymentSchema);

// `GET /projects/:id/releases`. `released_at` can be in the future for an upcoming release.
export const ReleaseSchema = z.object({
  tag_name: z.string().min(1),
  released_at: isoDateTime,
  upcoming_release: z.boolean().optional(),
  _links: z.object({ self: z.string().min(1).optional() }).optional(),
});
export type Release = z.infer<typeof ReleaseSchema>;
export const ReleasesSchema = z.array(ReleaseSchema);

// `GET /projects/:id/merge_requests?state=merged`. The title and author are deliberately not read.
export const MergeRequestSchema = z.object({
  iid: z.int().positive(),
  state: z.string().min(1),
  merged_at: isoDateTime.nullable(),
  web_url: z.string().min(1),
});
export type MergeRequest = z.infer<typeof MergeRequestSchema>;
export const MergeRequestsSchema = z.array(MergeRequestSchema);

/*
 * Webhook deliveries (#428), from GitLab's documented payloads
 * (https://docs.gitlab.com/user/project/integrations/webhook_events/, checked 2026-11-16). Only the
 * fields the timeline shows are declared: user names, emails, avatars, commit messages, merge
 * request titles, and descriptions are dropped by `z.object`.
 */

// GitLab sends hook times as ISO 8601 with milliseconds (`Gitlab::WebHooks.normalize_dates`), but a
// value a payload builder formats itself can still read `2016-08-12 15:23:28 UTC`, so both are read.
const RUBY_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/;
const hookDateTime = z
  .string()
  .transform((text) => text.replace(RUBY_UTC, "$1T$2Z"))
  .pipe(isoDateTime);

// The project every delivery StackDash maps names. `path_with_namespace` is the only link to the
// external account: no payload carries the namespace id `sync` reads.
const HookProjectSchema = z.object({
  id: z.int().positive(),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().min(1).nullable().optional(),
});
export type HookProject = z.infer<typeof HookProjectSchema>;

export const HookEnvelopeSchema = z.object({ object_kind: z.string(), project: HookProjectSchema });

// `Pipeline Hook`: sent on every status change; only `success` and `failed` become events.
export const PipelineHookSchema = z.object({
  object_kind: z.literal("pipeline"),
  object_attributes: z.object({
    id: z.int().positive(),
    iid: z.int().positive(),
    status: z.string().min(1),
    ref: z.string().min(1),
    finished_at: hookDateTime.nullable().optional(),
    url: z.string().min(1).optional(),
  }),
});

// `Deployment Hook`. `deployment_id` is the id `GET /projects/:id/deployments` returns; the hook
// carries neither the deployment's iid nor its ref.
export const DeploymentHookSchema = z.object({
  object_kind: z.literal("deployment"),
  status: z.string().min(1),
  deployment_id: z.int().positive(),
  environment: z.string().min(1),
  status_changed_at: hookDateTime,
});

// `Merge Request Hook`. `merged_at` arrived in GitLab 19.1; `updated_at` stands in before it.
export const MergeRequestHookSchema = z.object({
  object_kind: z.literal("merge_request"),
  object_attributes: z.object({
    iid: z.int().positive(),
    state: z.string().min(1),
    action: z.string().min(1).optional(),
    merged_at: hookDateTime.nullable().optional(),
    updated_at: hookDateTime,
    url: z.string().min(1).optional(),
  }),
});

// `Release Hook`: `create`, `update`, or `delete`.
export const ReleaseHookSchema = z.object({
  object_kind: z.literal("release"),
  action: z.string().min(1),
  tag: z.string().min(1),
  released_at: hookDateTime,
  url: z.string().min(1).optional(),
});

// `POST /projects/:id/hooks` (https://docs.gitlab.com/api/project_webhooks/). Only the id is kept.
export const ProjectHookSchema = z.object({ id: z.int().positive() });

// `PUT /projects/:id/hooks/:hook_id` answers with the webhook, whose `token_present` and
// `signing_token_present` (GitLab 19.0) say what it now holds (#617). Anything but a signing token
// and no secret token fails the parse, so the webhook stays marked and is tried again.
export const UpdatedProjectHookSchema = z.object({ token_present: z.literal(false), signing_token_present: z.literal(true) });

// `GET /projects/:id`, read only to tell a deleted webhook from a project out of reach.
export const ProjectIdSchema = z.object({ id: z.int().positive() });

const nonNegativeNumber = z.number().nonnegative();

/**
 * `POST /api/graphql` with the usage query in `index.ts`. A field the user may not read comes
 * back `null` with no error (GraphQL API, "Authorization"), so every part is nullable.
 */
export const UsageResponseSchema = z.object({
  data: z
    .object({
      namespace: z
        .object({
          actualSizeLimit: nonNegativeNumber.nullable(),
          rootStorageStatistics: z.object({ storageSize: nonNegativeNumber }).nullable(),
        })
        .nullable(),
      ciMinutesUsage: z
        .object({
          nodes: z.array(z.object({ monthIso8601: z.iso.date().nullable(), minutes: z.int().nonnegative().nullable() })),
        })
        .nullable(),
      ciMinutesProjectMonthlyUsage: z
        .object({
          nodes: z.array(
            z.object({
              minutes: z.int().nonnegative().nullable(),
              project: z.object({ id: z.string().min(1), fullPath: z.string().min(1) }).nullable(),
            }),
          ),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
