#!/usr/bin/env bash
# Starts the local Supabase stack in CI (#527). Local development runs `supabase start` directly.
#
# A start can fail for reasons outside the repository: the registry answers image pulls with
# "Rate exceeded" after the CLI's own pull retries run out, or a host port is still held by a
# socket the runner opened (the job reserves the stack's ports first, see ci.yml). Those failures
# are retried a bounded number of times, after `supabase stop --no-backup` clears whatever the
# failed attempt left behind. Any other failure, such as a migration error, fails at once.
set -euo pipefail

# `supabase stop --no-backup` deletes the stack's data, so this script refuses to run anywhere but
# a GitHub Actions runner, whose stack is throwaway.
if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "start-supabase.sh runs only in GitHub Actions; run \`supabase start\` locally." >&2
  exit 2
fi

max_attempts=3
transient='Rate exceeded|toomanyrequests|address already in use'
log="$(mktemp)"

for attempt in $(seq 1 "${max_attempts}"); do
  if supabase start 2>&1 | tee "${log}"; then
    exit 0
  fi
  # Classify on the failure itself, the last lines the CLI printed: a pull that hit a rate limit
  # and then recovered also logs "Rate exceeded" earlier, before a migration error that must not
  # be retried.
  if ! tail -n 5 "${log}" | grep -qE "${transient}"; then
    exit 1
  fi
  if [ "${attempt}" -eq "${max_attempts}" ]; then
    break
  fi
  delay=$((attempt * 30))
  echo "::warning::supabase start hit a registry rate limit or a held port (attempt ${attempt} of ${max_attempts}). Stopping the stack and retrying in ${delay}s."
  supabase stop --no-backup
  sleep "${delay}"
done

echo "::error::supabase start failed ${max_attempts} times on a registry rate limit or a held port. See the logs above."
exit 1
