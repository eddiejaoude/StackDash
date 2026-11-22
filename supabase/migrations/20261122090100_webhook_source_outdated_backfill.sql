-- Backfill for 20261122090000_webhook_source_outdated.sql (#617): marks every GitLab project webhook
-- StackDash created, so the after-sync pass gives each a signing token and clears its secret token.
--
-- Every stored GitLab webhook is marked, not only those made before #616 shipped: when this runs
-- is not known to the database, and updating a webhook #616 already signed sends the same signing
-- token again, so the cost of marking one too many is one idempotent call. Only rows not yet marked
-- are touched, so running it again changes nothing. One statement is enough: the table holds at
-- most 100 sources per endpoint (webhook_sources_enforce_limit), and only per-source endpoints,
-- which only GitLab has, hold rows.

update public.webhook_sources as source
set provider_webhook_outdated = true
from public.webhook_endpoints as endpoint
where endpoint.id = source.endpoint_id
  and endpoint.provider = 'gitlab'
  and source.provider_webhook_id is not null
  and not source.provider_webhook_outdated;
