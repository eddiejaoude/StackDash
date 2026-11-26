-- What a triggered alert is about, in words, so its short title can name it (#297).
--
-- The evaluator (src/lib/alerts/evaluate.ts) already builds this phrase for every rule: the
-- provider and metric of an allowance ("Vercel bandwidth"), the scope of a spend amount rule
-- ("Workspace spend"), or the budget ("Vercel monthly budget"). Until now it reached only the
-- sentence in `message`, so the alerts page and dashboard (src/lib/alerts/headline.ts) could title
-- two allowance alerts on one provider only "Vercel allowance".
--
-- Expand step only: a nullable column, no default, and no backfill. Rows recorded before this
-- migration keep a null subject and the provider and kind title, because the only source for their
-- subject is the sentence, and the sentence is never parsed.
--
-- Grants and RLS are unchanged: authenticated already holds select on the whole table and update
-- on acknowledged_at and acknowledged_by only, and only the service role writes the rest. Adding a
-- nullable column without a default does not rewrite the table.

alter table public.triggered_alerts
  add column subject text;

comment on column public.triggered_alerts.subject is
  'What the alert is about, as the evaluator words it ("Vercel bandwidth"); null for alerts recorded before #297.';
