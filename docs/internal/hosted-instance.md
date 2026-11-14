# Hosted instance runbook

Steps only Eddie performs on the hosted StackDash instance. This folder stays in the repository and is never published at `/docs` (`src/lib/docs.ts` skips `docs/internal/`). The deployment itself is described for any operator in [Deploy to Vercel and Supabase](../operations/deploy.md); this page adds who does what on the hosted instance.

Agents prepare configuration and preview deployments. They never trigger or promote a production deployment.

## Promote production (Eddie)

1. Merge to `main` after CI passes and the preview has been checked. Vercel builds a production deployment.
2. Before the deployment receives traffic, apply any new migrations ([Deploy, step 2](../operations/deploy.md#2-apply-the-migrations-forward-only)).
3. Promote or confirm the production deployment in Vercel.
4. Run the checks in [Deploy, verify the production deployment](../operations/deploy.md#8-verify-the-production-deployment).

## Hosted OAuth apps

The hosted instance has one registration per app ([OAuth apps](../operations/oauth-apps.md)), owned by the StackDash account or organization, with callbacks on the production origin. Eddie registers each one and enters its secrets in Vercel. Hosted users connect through these apps and never create their own.

## What stays Eddie's

- Creating the Vercel project, the production (and staging) Supabase projects, and the SMTP sender.
- Registering the sign-in OAuth app and one app per provider ([OAuth apps](../operations/oauth-apps.md)), and entering their secrets.
- Generating and storing the production secrets.
- Setting the operator variables in the hosted instance's production environment ([Deploy, environment variables](../operations/deploy.md#environment-variables)): `STACKDASH_OPERATOR_NAME` is `Eddie Jaoude`, `STACKDASH_OPERATOR_EMAIL` is `eddie@jaoudestudios.com`, and `STACKDASH_GOVERNING_LAW` is `England and Wales`.
- Running migrations against production, registering the cron job, and inviting testers.
- Promoting production deployments. Agents never trigger or promote one.
- Migrating and rotating the JWT signing keys of the production (and staging) Supabase projects ([JWT signing keys](../operations/deploy.md#jwt-signing-keys)).
- Turning on GitHub secret scanning and push protection for the repository. In **Settings, Code security** (called **Advanced Security** in newer GitHub layouts), enable **Secret scanning** and **Push protection**. For a private repository this needs GitHub Secret Protection, a paid part of GitHub Advanced Security; both are free once the repository is public. Until they are on, the gitleaks scan in CI is the only automated secret check, and it only runs after a push. Confirm with `gh api repos/eddiejaoude/StackDash --jq '.security_and_analysis'`: `secret_scanning` and `secret_scanning_push_protection` must both show `"status": "enabled"`.
- Turning on private vulnerability reporting, which `SECURITY.md` names as the way to report a vulnerability. GitHub offers it for public repositories only: while the repository is private, `gh api -X PUT repos/eddiejaoude/StackDash/private-vulnerability-reporting` answers `404 Not Found` and reports go to the email address in `SECURITY.md`. Once the repository is public, run that command again (or enable **Private vulnerability reporting** in **Settings, Code security**) and confirm with `gh api repos/eddiejaoude/StackDash/private-vulnerability-reporting`: it must show `"enabled": true`.
- Checking the issue chooser after the contributor templates in `.github/ISSUE_TEMPLATE/` reach `main`. GitHub reads issue templates from the default branch only, so no branch before that can show them. On the repository, open **Issues**, then **New issue**: the chooser must list **Bug report**, **Adapter request**, and **Task**, and one **Report a security vulnerability** row that opens the security policy. GitHub may add its own row of that name once `SECURITY.md` is on `main`. If both show, remove the `contact_links` entry from `.github/ISSUE_TEMPLATE/config.yml`: it duplicates GitHub's row.
- Turning the CI workflow back on before the repository takes pull requests from outside contributors. `CONTRIBUTING.md` tells contributors that CI runs on every pull request, and the workflow was switched off before launch. Check with `gh api repos/eddiejaoude/StackDash/actions/workflows --jq '.workflows[] | {name, state}'`: while CI shows `"state": "disabled_manually"`, run `gh workflow enable ci.yml -R eddiejaoude/StackDash` and check again. CI must show `"state": "active"`.
