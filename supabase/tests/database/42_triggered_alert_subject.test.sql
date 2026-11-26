-- triggered_alerts.subject (#297, 20261126110000_triggered_alert_subject.sql): a nullable text
-- column with no default, readable by a signed-in member like the rest of the table and written by
-- the service role only, so the expand step changed no grant.
begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

select has_column('public', 'triggered_alerts', 'subject', 'triggered_alerts has a subject column');
select col_type_is('public', 'triggered_alerts', 'subject', 'text', 'subject is text');
select col_is_null('public', 'triggered_alerts', 'subject', 'subject is nullable: alerts recorded before it keep null');
select col_hasnt_default('public', 'triggered_alerts', 'subject', 'subject has no default, so nothing is invented for older alerts');
select ok(
  has_column_privilege('authenticated', 'public.triggered_alerts', 'subject', 'SELECT'),
  'authenticated may read subject, as it reads the rest of the table');
select ok(
  not has_column_privilege('authenticated', 'public.triggered_alerts', 'subject', 'UPDATE')
    and not has_column_privilege('authenticated', 'public.triggered_alerts', 'subject', 'INSERT'),
  'authenticated may not write subject: only the service role records alerts');

select * from finish();
rollback;
