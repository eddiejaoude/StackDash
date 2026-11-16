# Contributing to StackDash

This guide is for anyone contributing from outside the maintainer team, and for the AI assistants
they work with. It covers what to do before you start, how to set up and check your work, the
branch, commit, and pull request conventions, how review works, and the rules your code is held to
in review. The maintainers work from a longer set of house rules on their own machines; this file
carries the rules from it that your change is reviewed against. If a review cites a rule that is
not written here, ask for it to be added.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## License and contribution terms

StackDash is licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`), copyright Eddie Jaoude.
The decision and its reasons are on [#8](https://github.com/eddiejaoude/StackDash/issues/8). The
license grants no trademark rights in the StackDash name or logo: [TRADEMARKS.md](TRADEMARKS.md)
says how you can use those, including keeping the name on a fork you use to contribute.

- Your contribution is licensed under the same terms as the rest of the code.
- If you run a modified version for other people over a network, the license requires you to offer
  them its source code (section 13 of the license).
- Contributions need a signed
  [contributor license agreement](https://gist.github.com/eddiejaoude/f62aa5c24c7979993471e99385567506)
  (CLA), based on the Apache Individual CLA. It grants Eddie Jaoude, the copyright holder, the
  right to license your contribution under other terms as well as the AGPL, so the code can be
  relicensed or dual-licensed later. You keep the copyright in your contribution.
- To sign, open your pull request. The CLA Assistant bot comments with a link: follow it, read the
  agreement, and select "Sign in with GitHub to agree". Signing in signs the agreement; there is no
  second confirmation. You sign once, and it covers your present and future contributions. The
  `license/cla` check then passes without a new push. A maintainer merges a pull request only
  after it passes.
- The check covers every commit author on the pull request, not only the person who opened it.
  Commit with an email address linked to your GitHub account. If the bot says an author is not a
  GitHub user, add that email to the account and use the recheck link in the bot's comment; no new
  push is needed.
- Does your employer have rights to what you write, including in your own time? Then check that it
  allows your contribution before you sign: section 4 of the agreement covers this.

## Before you start

- **Found a security vulnerability?** Do not open an issue or a pull request. Follow
  [SECURITY.md](SECURITY.md).
- **Every change that is more than a typo or a one-line copy fix starts with an issue.** Search
  the open and closed issues first. Then open one from the
  [issue chooser](https://github.com/eddiejaoude/StackDash/issues/new/choose):
  - **Bug report** for something that does not work.
  - **Adapter request** to connect a new provider. A maintainer answers with go or no-go before
    anyone writes the adapter.
  - **Task** for planned work, written so anyone can pick it up cold.
- **Pick up an existing issue by commenting that you are taking it**, so two people do not build
  the same thing. Do not start on an issue that is assigned to someone else or labeled `blocked`.
- **Some choices belong to the maintainer, so raise them on the issue before writing code:**
  adding or swapping a runtime dependency, choosing a third-party service (email, payments,
  hosting, analytics, auth), a vendor SDK versus a hand-written client, and anything self-hosters
  would have to sign up for. Where there are two or more real options, post them as one table with
  the columns `Option`, `Pros`, `Cons`, `Effort`, and `Impact`, including leaving things as they
  are.

## Write a provider adapter

Adapters connect StackDash to a provider's API. The [adapter guide](docs/adapters.md) takes you
from a copy of the example adapter to a pull request: the adapter contract, the test harness, every
file a new provider touches, the provider page template, and how adapters are reviewed. Open an
**Adapter request** issue and wait for the go or no-go before you start.

## Set up

Follow [Run it locally](docs/development.md#run-it-locally) in the local development guide from a
fresh clone, in order: the prerequisites, `npm ci`, the local Supabase stack, `.env.local`,
migrations, seed data, signing in, and the fake provider. Fork the repository first and clone your
fork instead of the main repository. If a step is missing or wrong, fix `docs/development.md` in
the same pull request, and the README's short version in "Try it with simulated data" when the
step is one of steps 1 to 6.

Three things to know before you write code:

- **Read the documentation for the installed version first.** Before writing code against a
  library, read its documentation for the version in `package-lock.json`, and follow the approach
  it recommends rather than what you or your AI assistant remember.
- **This Next.js version has breaking changes.** APIs, conventions, and file structure may differ
  from your memory or your AI assistant's training data. Read the guide for the API you touch in
  `node_modules/next/dist/docs/` before writing code, and heed its deprecation notices.
- **New migrations apply forward.** Run `supabase migration up` after pulling new migrations.
  `supabase db reset` wipes your local data and every signed-in session; use it only when you mean
  to test that the migrations apply from scratch.

## Checks

Run these before you ask for review. [Checks](docs/development.md#checks) in the local development
guide explains each one, and which need the local Supabase stack running.

```bash
npm run typecheck        # generate route types, then tsc
npm run lint             # eslint, zero warnings allowed
npm test                 # unit tests (Vitest)
npm run test:db          # database tests (pgTAP)
npm run db:types:check   # fails if the generated database types are stale
npm run build            # production build
npm run test:e2e         # Playwright end-to-end tests
```

While you work, run the narrowest check that proves your change, such as `npx vitest run <file>`
or `npx playwright test <spec>`, then the full set once at the end. CI
(`.github/workflows/ci.yml`) runs the same checks on pull requests, plus `supabase db lint`,
`npm audit`, and a gitleaks secret scan. Two more workflows run on every pull request: dependency
review (`.github/workflows/dependency-review.yml`) fails it when it adds or changes a dependency
with a known vulnerability, and CodeQL (`.github/workflows/codeql.yml`) scans the TypeScript and
the workflows for security problems. None of them needs repository secrets, so a pull request from
a fork gets the same checks.

## Branches and commits

- **Branch from `main`**, named `<issue>-<slug>`, for example `123-timeline-empty-state`.
- **Every commit subject is `type(scope): imperative summary`.**
  - `type` is one of `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
  - `scope` is the issue's `area: *` label without the prefix: `area: timeline` becomes
    `timeline`. The areas are on the [labels page](https://github.com/eddiejaoude/StackDash/labels).
  - Lowercase after the colon, present tense ("add", not "added"), no trailing period, 72
    characters or fewer.
- **The commit body says why, not what.** The diff already says what. Wrap it at 72 columns.
- **The last line of the last commit is `Closes #<issue>`**, on its own line.
- **One concern per commit.** Formatting, renames, and dependency changes are their own commits,
  so a reviewer can skip them and a revert does not take a feature with it.
- **Never rewrite history once review has started.** No force-push and no rebase: add a commit
  for each fix, and bring in `main` with a merge commit.
- **Never commit** a secret, a `.env*` file other than `.env.example`, build output, an OS file such
  as `.DS_Store`, a screenshot, or another large binary.

Example:

```text
fix(timeline): keep the filter open after applying it

The filter closed on every submit, so changing two filters took two
round trips and lost the keyboard position each time.

Closes #123
```

## Pull requests

- **The title follows the commit format**, `type(scope): imperative summary`, because a squash
  merge makes it the commit subject on `main`.
- **Fill in every section of the template**: `Closes #<issue>`, what changed, why, evidence, how it
  was verified, and notes for review.
- **Evidence.** A user-visible change shows before and after screenshots of the same scenario,
  side by side: same browser, viewport, route, data, and color scheme. Capture the before state
  from `main` before you change anything; never reconstruct it afterwards. Use a short video when
  motion, focus, or a multi-step flow is what changed. Attach the files to the pull request
  (drag them into the description, or `gh pr create --attach`) and never commit them. Use
  synthetic data only, and check every image for tokens, emails, private URLs, and real account
  data before you upload it. A change nobody sees writes `Visual evidence: not applicable` and
  gives command output instead.
- **How it was verified** lists each command you ran and its result, and anything you did not run
  and why. A claim that it works is not verification.
- **Update the docs in the same pull request**: the README, `.env.example`, the pages in `docs/`,
  and the provider page for an adapter. A document that is wrong costs more than no document.

## Review process

1. **A maintainer reviews every pull request.** Nothing merges without that review and green CI,
   and only a maintainer merges.
2. **Findings come inline**, on the line at fault, each prefixed with a severity:
   - `should-fix:` must change before merge.
   - `consider:` is an improvement the reviewer recommends. Fix it by default too.
3. **Reply in each thread** with one of two answers:
   - `Fixed in <sha>: <what changed, where>`.
   - `Not doing it: <reason>`, where the reason is that it is out of scope (open an issue and link
     it), that the reviewer is wrong (show the evidence: code, documentation, command output), or
     that it needs a maintainer decision (post the options table).
4. **Never resolve a thread yourself.** The reviewer resolves it once satisfied.
5. **Push the fixes, then leave one comment** listing each finding as fixed or declined, and the
   SHA that carries the fixes. The reviewer re-reads at that SHA.

## Rules your change is reviewed against

### Copy and voice

These apply to everything a user reads: UI text, labels, errors, empty states, emails, docs,
issues, and pull requests. Code comments are exempt.

- Never use an em dash or an en dash. Use a colon, a full stop, or a word.
- US English (`color`, `behavior`, `license`), ISO dates (`YYYY-MM-DD`), and times in
  Europe/London unless the screen says otherwise.
- Sentence case for headings, buttons, labels, and table columns. No exclamation marks.
- An empty field shows a word such as `unknown`, never a dash.
- An error says what happened, what it affected, and what to do next, and offers the retry button
  when retrying is the answer. Never "Oops" or a bare "Something went wrong".
- Buttons and links name the outcome: "Save changes", never "Submit", "OK", or "Click here".
- Never blame the user and never show internals: no stack traces, SQL, provider error codes, or
  internal ids. Show a short reference id and log the detail against it.
- No marketing adjectives (seamless, effortless, blazing fast), and the user's word rather than the
  code's: the UI says workspace even where a table says otherwise.

### Accessibility

A user-visible change is not finished until it works without a mouse and without perfect
eyesight.

- Every interactive element is reachable and operable by keyboard in a sensible order, with a
  visible focus style. A modal traps focus, closes on Escape, and returns focus to its trigger.
- Real semantics: `<button>` for actions, `<a href>` for navigation, a label for every input, one
  `<h1>`, headings in order. Use ARIA only when no element does the job.
- Contrast of at least 4.5:1 for body text and 3:1 for large text and control boundaries. Color is
  never the only way meaning is shown.
- Async results announce themselves (`aria-live`). A failed form submit moves focus to the error
  summary, and each message is tied to its field with `aria-describedby`.
- Images have `alt` text that states their meaning, or `alt=""` when decorative.
- Respect `prefers-reduced-motion`, never disable zoom, and make targets at least 24 by 24 CSS
  pixels.
- **Report both checks in the pull request**: the automated scan on the changed screen
  (`expectNoAxeViolations` in `e2e/fixtures/axe.ts`) and one keyboard-only pass.

### Code

- **Reuse before you add.** Search for an existing component, helper, or type first. Extract
  shared logic on its third occurrence, not before.
- **Match the file you are editing**: naming, layout, error handling, data fetching, and test
  structure. Never introduce a second convention beside a working one.
- **Strict types.** Never `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, or a non-null
  `!` on a value you have not just checked. Unknown input is `unknown`, parsed once at the boundary
  with a Zod schema. Derive types from schemas and the generated database types instead of copying
  them. Never loosen a compiler flag.
- **No suppressions.** Fix the cause instead of adding `eslint-disable`, swallowing an error, or
  special-casing the failing input.
- **Errors**: a `catch` handles the error or rethrows it with its `cause`. Expected failures
  (validation, not found, permission denied) are return values, not exceptions. Every outbound
  call has a timeout. Use the structured logger in `src/lib/log`, never `console.log`.
- **Every user-facing route has an error boundary and an empty state**, and both are tested.
  Retries are for idempotent operations only: bounded, backed off, and capped.
- **Server first.** Server Components by default, `"use client"` only at the leaf that needs it,
  and independent fetches run together with `Promise.all`.
- **Clean cutover.** When you replace something, migrate every caller and delete the old path. No
  stubs, placeholders, `TODO: implement`, or fake data in delivered work.
- **Comments say why**, never what the next line does.
- **Dependencies are permanent.** Check whether the platform or something already installed does
  the job first. Adding a runtime dependency is a maintainer decision (see Before you start).
  Never hand-edit `package-lock.json`.

### Security and data

- **Every mutation authorizes the caller**, for this specific row. A Server Action or route
  handler is a public endpoint; row level security is defense in depth, not the check.
- **Identity comes from the verified session**: `getClaims()` or `getUser()`, never `getSession()`,
  and never a user id from the request body or a query parameter. `src/proxy.ts` refreshes the
  session and redirects; it does not authorize, so every handler and query still checks.
- **Trust nothing from the client**: amounts, ids, roles, statuses, and redirect targets are read
  again on the server. Redirects go only to allow-listed relative paths.
- **Validate input at the boundary with a schema that rejects unknown fields.** Never spread a
  request body into an update.
- **Rate limit anything that sends email, costs money, or creates records**, keyed by user and by
  IP.
- Never build SQL by concatenation, and never pass user content to `dangerouslySetInnerHTML`.
- **A route handler that changes state verifies `Origin`** and allow-lists origins rather than `*`.
  Server Actions get the framework's protection; a bare `POST` handler gets none.
- **A webhook handler verifies the signature against the raw body** before parsing it, with a
  constant-time compare, and rejects stale timestamps. It is idempotent: store the provider event
  id and ignore repeats, because delivery is at least once and out of order.
- **The service-role key stays on the server.** `SUPABASE_SERVICE_ROLE_KEY` bypasses row level
  security, so it never reaches a client component or the browser bundle.
- A missing row and a row you do not own return the same response.
- **Money is an integer in minor units with its ISO 4217 currency**, never a float. Timestamps are
  `timestamptz` in UTC; format dates and amounts only at the edge, with `Intl`.
- Units live in the identifier: `timeoutMs`, `ttlSeconds`, `amountMinor`, never a bare `timeout`.
- Ids are opaque: never parse one or sort by one. Order by `created_at`.
- An enumeration has one home: a database enum or a literal union with generated types.
- Personal data never goes into logs, analytics events, error messages, fixtures, or screenshots.
- Never log a secret, a token, or a whole request body.

### Performance and data access

- **Every list query is paginated and bounded on the server.** No unbounded select, however few
  rows there are today.
- Select only the columns you use, never `select('*')`.
- **Every column in a filter, sort, or join has an index**, and a composite index matches the
  query's column order. Name the index the query uses in the pull request.
- **No queries inside a loop.** Batch them, join, or use one `in` clause. An N+1 that is instant
  against five local rows times out against five thousand real ones.
- Anything unbounded gets a limit: request bodies, uploads, in-memory collections, and provider
  pagination loops.
- **Stop what you start**: unsubscribe realtime channels, clear intervals and listeners, and abort
  in-flight requests on unmount or navigation.
- **Caching and revalidation are a stated decision per route**: say the revalidate value or tag
  strategy and why.

### Database

- Every schema change is a forward-only migration in `supabase/migrations`. Fix a bad migration
  with a new one, and never change the schema by hand.
- Every new table has row level security on, with its policies in the same migration.
- Regenerate the types with `npm run db:types` and commit them.
- Change a live column in steps: add the new one, backfill, switch reads and writes, then drop the
  old one in a later migration. Never rename or drop in the migration that adds the replacement.
- Database behavior gets a pgTAP test in `supabase/tests/database`.

### Secrets

- Never write a password, API key, token, private key, or connection string anywhere in the
  repository, including tests, fixtures, docs, and examples. Use a placeholder such as
  `<access-token>`, and build fake keys at runtime in tests.
- Secrets live in your git-ignored `.env.local`. A new environment variable goes into
  `.env.example` with an empty value and a one-line note saying what it is for and where to get it.
- Provider work stays in sandbox or test mode, against your own accounts and your own OAuth apps.
- Committed a secret by mistake? Rotate it now and say so in the pull request: deleting the line
  does not remove it from history.

### Tests

- **Every unit of behavior gets a happy-path test and a boundary test.** Boundaries are the values
  that break naive code: empty, one, and many; zero, negative, and maximum; either side of a limit;
  `null`, `undefined`, and empty strings; expired dates; duplicate submits; signed out and wrong
  owner; a third-party call that fails or times out. Name the boundary in the test title.
- **A bug fix reproduces the bug in a test first**, then fixes it.
- **A user-visible flow has Playwright coverage**: add a spec for a new flow, update it for a
  changed one, delete it for a removed one. Select by role, label, or accessible name, never by
  CSS class; wait for a condition, never for a fixed time.
- Tests use deterministic synthetic data and never reach a live network or a real account.
- Never make a check pass by weakening it: no `.only`, `.skip`, deleted tests, or loosened
  assertions.

## Working with an AI assistant

You are responsible for every line you submit, whoever wrote it. [AGENTS.md](AGENTS.md) points AI
assistants at this guide. When an assistant writes an issue, a pull request description, or a
comment, end it with one line naming the model and its reasoning setting, so reviewers can tell
which tool produced what:

```text
Model: <model> | Reasoning effort: <effort>
```
