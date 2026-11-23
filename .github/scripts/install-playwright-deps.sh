#!/usr/bin/env bash
# Installs the system packages the Playwright browsers need, in CI (#641). Local setup is in
# docs/development.md.
#
# The packages come from the runner's Ubuntu mirror. A mirror that stalls makes apt wait out each
# download before it falls back to another one, and one such run spent 20 minutes here, after which
# the job's timeout cancelled the end-to-end suite. So apt gives up on a stalled download sooner and
# retries it, and each attempt here has a time limit: an attempt that runs past it is stopped and the
# install starts again, keeping what was already downloaded. Typical runs take under a minute.
set -euo pipefail

# The apt settings below change the host, so this script refuses to run anywhere but a GitHub
# Actions runner, which is thrown away after the job.
if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "install-playwright-deps.sh runs only in GitHub Actions; see docs/development.md." >&2
  exit 2
fi

browsers=(chromium webkit firefox)
max_attempts=3
attempt_seconds=240

# apt waits 120 seconds on a stalled connection by default before it moves on to the next mirror.
sudo tee /etc/apt/apt.conf.d/80stackdash-ci-fetch > /dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT

for attempt in $(seq 1 "${max_attempts}"); do
  # timeout signals its whole process group when the limit passes. Run as root, Playwright starts
  # apt-get itself, inside that group. Run as the runner user it would start apt-get through sudo,
  # which keeps apt-get running after the signal, holding the dpkg lock.
  if sudo env "PATH=${PATH}" timeout --kill-after=15 "${attempt_seconds}" npx playwright install-deps "${browsers[@]}"; then
    exit 0
  fi
  if [ "${attempt}" -eq "${max_attempts}" ]; then
    break
  fi
  echo "::warning::Installing the Playwright system packages failed or ran past ${attempt_seconds}s (attempt ${attempt} of ${max_attempts}). Retrying."
  # An attempt stopped mid-install can leave packages unpacked but not configured.
  sudo dpkg --configure -a
done

echo "::error::Installing the Playwright system packages failed ${max_attempts} times. See the apt output above."
exit 1
