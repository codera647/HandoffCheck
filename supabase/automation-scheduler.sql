-- Operator template. scripts/configure-automation.mjs fills placeholders in an ignored file.
-- Never run this template directly or commit the filled file.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create schema if not exists handoff_internal;
revoke all on schema handoff_internal from public,anon,authenticated,service_role;
create table if not exists handoff_internal.automation_clock (
  workspace_id uuid primary key references public.workspaces(id), last_reminder timestamptz not null default '-infinity'
);
alter table handoff_internal.automation_clock add column if not exists last_maintenance timestamptz not null default '-infinity';
revoke all on handoff_internal.automation_clock from public,anon,authenticated,service_role;
insert into handoff_internal.automation_clock(workspace_id) values('__WORKSPACE_ID__') on conflict do nothing;
do $$
declare secret_id uuid;
begin
  select id into secret_id from vault.secrets where name='handoffcheck_automation_worker';
  if secret_id is null then
    perform vault.create_secret('__SECRET__','handoffcheck_automation_worker','Dedicated automation HMAC key');
  else
    perform vault.update_secret(secret_id,'__SECRET__','handoffcheck_automation_worker','Dedicated automation HMAC key');
  end if;
end; $$;
create or replace function handoff_internal.dispatch_automation() returns void language plpgsql security definer set search_path='' as $$
declare w constant uuid:='__WORKSPACE_ID__'; raw constant text:='{"action":"run"}'::jsonb::text; secret text; stamp text; nonce text; signature text; remind boolean; maintenance boolean;
begin
  -- One SQL check per minute. No Edge invocation while there is no due work.
  if not pg_try_advisory_xact_lock(hashtextextended('handoffcheck-automation',0)) then return; end if;
  select p.reminders and c.last_reminder<now()-interval '1 hour' into remind
    from public.automation_policies p join handoff_internal.automation_clock c on c.workspace_id=p.workspace_id where p.workspace_id=w;
  select last_maintenance<now()-interval '1 day' into maintenance from handoff_internal.automation_clock where workspace_id=w;
  if not coalesce(remind,false) and not coalesce(maintenance,false) and not exists(select 1 from public.automation_jobs j join public.automation_policies p on p.workspace_id=j.workspace_id
    join public.workspaces ws on ws.id=p.workspace_id
    where j.workspace_id=w and ws.review_mode='ai' and
      ((j.state='queued' and j.next_attempt<=now()) or (j.state='working' and j.lease_until<=now()))) then return; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name='handoffcheck_automation_worker';
  if secret is null then raise exception 'Automation scheduler credential is missing.'; end if;
  stamp:=floor(extract(epoch from clock_timestamp())*1000)::bigint::text;
  nonce:=gen_random_uuid()::text;
  signature:=encode(extensions.hmac(convert_to(stamp||E'\n'||nonce||E'\n'||raw,'UTF8'),convert_to(secret,'UTF8'),'sha256'),'hex');
  perform net.http_post(url:='https://__PROJECT_REF__.supabase.co/functions/v1/automation-worker',
    body:=raw::jsonb,headers:=jsonb_build_object('Content-Type','application/json','x-handoff-timestamp',stamp,
      'x-handoff-nonce',nonce,'x-handoff-signature',signature),timeout_milliseconds:=60000);
  if coalesce(remind,false) then update handoff_internal.automation_clock set last_reminder=now() where workspace_id=w; end if;
  if coalesce(maintenance,false) then update handoff_internal.automation_clock set last_maintenance=now() where workspace_id=w; end if;
end; $$;
revoke execute on function handoff_internal.dispatch_automation() from public,anon,authenticated,service_role;
select cron.schedule('handoffcheck-automation','* * * * *','select handoff_internal.dispatch_automation();');
commit;
