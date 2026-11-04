# Workspaces, connections, accounts, and projects

Issues: #139. A workspace holds everything. A connection is one OAuth grant to a provider, each connection finds one or more external accounts to measure, and a project is a name you create to group external accounts across providers. This page says what each one is for. The tables, keys, and policies behind them are in [Database schema](schema.md).

| Concept | What it is | Created by | Table |
|---|---|---|---|
| Workspace | The tenant: members, roles, and every row below | Sign-up (personal workspace) | `workspaces`, `workspace_members` |
| Connection | One OAuth grant to one provider | An admin, on the Connections page | `connections` |
| External account | One thing a provider bills or measures: a team, an organization, a Stripe account, a Supabase project | DevMacro, when a connection is made or reconnected | `external_accounts` |
| Project | A group of external accounts, usually one product | An admin, on the Projects page | `projects` |

## Workspace

The workspace is the tenant and the security boundary. Every other row carries a `workspace_id`, and row level security answers every read and write through `has_workspace_role`, using the caller's role in `workspace_members`.

- Roles are viewer, admin, and owner. Viewers read everything in the workspace. Admins also manage connections, external accounts, projects, budgets, and alert rules, acknowledge alerts, and rename the workspace. Owners also delete the workspace and grant ownership. The full matrix is in [Roles and row level security](schema.md#roles-and-row-level-security).
- Sign-up creates one personal workspace with the new user as its owner. `is_personal` only changes how the workspace is shown, never what anyone may do in it.
- A user can belong to more than one workspace and switches between them in the app. Creating further workspaces (#106) and inviting members by email (#107) come with teams (#105); until then a shared workspace exists only in local seed data (Acme in `supabase/seed.sql`).
- Workspace URLs are `/w/<slug>/...`. The slug is random and never changes, so renaming a workspace never breaks a link.

## Connection

A connection is one OAuth grant from one provider account to one workspace. DevMacro never asks for API keys.

- The connection holds the sync state: status, polling interval, next and last sync time, and missing permissions. Its tokens are encrypted in `connection_credentials`, which only the server can read.
- The scheduler syncs one connection per job. See [Jobs](../operations/jobs.md).
- One grant can reach more than one thing to measure, and some providers need one grant per account. For example, a GitHub user with a personal account and two organizations installs the app three times and gets three connections ([GitHub, Limitations](../providers/github.md#limitations)).

## External account

An external account is the thing a provider actually bills or measures. In the app it is called an account, and it appears under its connection on the connection's page. You never create one: when a connection is made, the provider adapter lists the accounts the grant reaches and DevMacro stores them. Reconnecting lists them again, adds any new ones, and keeps each existing account's project and included choice. Syncing never adds accounts, and nothing removes one except deleting its connection: an account the provider stops listing stays, with its history, until then.

| Provider | Kind | What one external account is |
|---|---|---|
| GitHub | `organization` or `user` | The account the GitHub App is installed on |
| Vercel | `team` or `user` | A team, or a Hobby personal account |
| Stripe | `account` | One Stripe account in one mode, live or test |
| Supabase | `project` | One Supabase project in any organization the grant can see (branches are skipped) |
| Resend | `team` | The Resend team the grant covers |

Usage belongs to the external account: `usage_snapshots` holds one row per external account, metric, and UTC day. Activity events can name the external account they are about.

An admin changes two things on an external account, and nothing else:

- **Included.** Only included accounts are synced, shown on the dashboard, and checked by alert rules. Accounts are included by default. Excluding one stops all three without deleting its history.
- **Project.** Which project the account belongs to, or none.

## Project

A project is a name you choose, unique in the workspace, that groups external accounts from any provider. It stores no data of its own. The usual use is one project per product: the Vercel team, the Supabase project, and the Resend team behind one app all go into one project, so the product can be watched as a whole instead of one provider at a time.

A project is used in four places:

- **Dashboard.** The "By project" section shows spend for the current billing period per project. A project appears there once one of its included accounts has spend in the current period, and accounts with no project are listed last, as Unassigned.
- **Filter.** The dashboard and the timeline can be narrowed to one or more projects, or to Unassigned.
- **Budgets.** A budget can apply to a project.
- **Alert rules.** A rule can apply to a project. It matches a reading when the reading's external account belongs to that project.

Projects are optional. Budgets and alert rules can also apply to the whole workspace, to one provider, or to one connection.

Deleting a project:

- leaves its external accounts in place, with no project, keeping their history
- deletes the budgets that apply to the project
- deletes the alert rules that apply to the project or to one of those budgets

The delete dialog counts each of these before an owner or admin confirms.

## Words that mean two things

| Word | Meaning on this page | The other meaning |
|---|---|---|
| Account | An external account: something at a provider that DevMacro measures | Your DevMacro sign-in, managed on the Account page. Deleting it deletes the workspaces where you are the only member, and is blocked while you are the only owner of a workspace that has other members |
| Project | A DevMacro project: your group of external accounts | A Supabase project, which DevMacro treats as an external account of kind `project`. It can be assigned to a DevMacro project like any other account |

## Example

1. Sign in. DevMacro creates your personal workspace.
2. Connect Vercel. That creates a connection and stores its external account, the team "My team".
3. Connect Supabase. That stores one external account per Supabase project, including "storefront-db".
4. Create the project Storefront and assign "My team" and "storefront-db" to it.
5. The dashboard's "By project" section shows Storefront's spend, and an alert rule for Storefront applies to readings from both accounts. Only Vercel adds spend here, because Supabase reports plan limits and activity but no spend ([Supabase](../providers/supabase.md)). Totals are kept per currency and never added across currencies.
