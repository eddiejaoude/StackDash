-- Provider webhooks (#28): a new job kind. Added in a migration of its own because a new enum value
-- cannot be used in the transaction that adds it, and the next migration uses it in a check
-- constraint and in a function.
--
-- webhook: processes one verified delivery (webhook_deliveries), queued by the webhook route as it
--   stores the delivery, so the route answers within the provider's deadline.

alter type public.sync_job_kind add value if not exists 'webhook';
