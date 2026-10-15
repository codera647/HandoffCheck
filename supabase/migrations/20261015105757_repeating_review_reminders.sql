begin;

create table public.request_reminders (
  request_id uuid primary key references public.requests(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id), enabled boolean not null,
  email_enabled boolean not null default true, interval_minutes integer not null check(interval_minutes between 15 and 10080),
  version integer not null default 1, review_id uuid references public.review_runs(id),
  next_due_at timestamptz, last_sent_at timestamptz
);
create index request_reminders_due on public.request_reminders(workspace_id,next_due_at) where enabled and next_due_at is not null;
alter table public.request_reminders enable row level security;
revoke all on public.request_reminders from public,anon,authenticated;
grant all on public.request_reminders to service_role;

-- One delivery slot per review/recipient. New cycles replace old queued work; no catch-up burst.
create table public.reminder_emails (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  request_id uuid not null references public.requests(id) on delete cascade,
  review_id uuid not null references public.review_runs(id), recipient_id uuid not null references auth.users(id),
  delivery_key uuid not null default gen_random_uuid(), cycle_at timestamptz not null,
  plan_version integer not null, state text not null default 'pending' check(state in ('pending','sending','sent','failed','cancelled')),
  attempts integer not null default 0 check(attempts between 0 and 3), next_attempt timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz, last_error text, last_sent_at timestamptz,
  payload jsonb, unique(review_id,recipient_id)
);
create index reminder_email_due on public.reminder_emails(workspace_id,next_attempt) where state in ('pending','sending');
alter table public.reminder_emails enable row level security;
revoke all on public.reminder_emails from public,anon,authenticated;
grant all on public.reminder_emails to service_role;

create function public.pending_review_recipient(p_request uuid,p_recipient uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.requests r
    join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    join public.review_runs run on run.id=r.current_review_id and run.state='succeeded' and run.revision=v.number and run.input_hash=v.input_hash
    join public.memberships m on m.workspace_id=r.workspace_id and m.user_id=p_recipient and m.status='active'
    where r.id=p_request and not r.archived and r.status in ('ready_for_approval','partially_approved')
      and r.current_revision>=r.minimum_approval_revision and m.user_id<>r.author_id
      and ((m.role='product_lead' and v.product_reviewer_id=m.user_id) or (m.role='engineering_lead' and v.engineering_reviewer_id=m.user_id))
      and not exists(select 1 from public.approvals a where a.review_id=r.current_review_id and a.member_id=m.user_id));
$$;

create function public.request_reminders_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.requests; p public.request_reminders; email_state text; last_email timestamptz;
begin
  perform public.assert_request_access(p_id);
  select * into r from public.requests where id=p_id;
  select * into p from public.request_reminders where request_id=p_id;
  select case when bool_or(state='failed') then 'failed' when bool_or(state='sending') then 'sending'
    when bool_or(state='pending') then 'queued' when bool_or(state='sent') then 'sent' else 'waiting' end,max(last_sent_at)
    into email_state,last_email from public.reminder_emails where request_id=p_id and review_id=r.current_review_id and plan_version=p.version;
  return jsonb_build_object('enabled',coalesce(p.enabled,false),'emailEnabled',coalesce(p.email_enabled,true),
    'intervalMinutes',coalesce(p.interval_minutes,1440),'version',coalesce(p.version,0),'custom',p.request_id is not null,
    'state',case when not coalesce(p.enabled,false) then 'off' when r.archived or r.status in ('approved','brief_ready') then 'stopped'
      when p.next_due_at is not null then 'scheduled' else 'waiting' end,
    'nextDueAt',p.next_due_at,'lastSentAt',p.last_sent_at,'lastEmailSentAt',last_email,
    'emailStatus',case when not coalesce(p.enabled,false) or not coalesce(p.email_enabled,false) then 'off' else coalesce(email_state,'waiting') end);
end; $$;

create function public.request_reminders_set(p_id uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.requests; p public.request_reminders; enabled boolean; email_enabled boolean; minutes integer;
begin
  select * into r from public.requests where id=p_id for update;
  perform public.assert_request_access(p_id);
  if r.author_id<>auth.uid() then raise exception 'FORBIDDEN|Only the author can change the reminder schedule.'; end if;
  select * into p from public.request_reminders where request_id=p_id;
  if coalesce(p_input->>'expectedRevision','') !~ '^\d{1,8}$' or (p_input->>'expectedRevision')::integer<>r.current_revision then raise exception 'STALE_REVISION|This request changed. Reload before saving reminders.'; end if;
  if coalesce(p_input->>'expectedVersion','') !~ '^\d{1,8}$' or (p_input->>'expectedVersion')::integer<>coalesce(p.version,0) then raise exception 'STALE_REVISION|This reminder schedule changed. Reload before saving.'; end if;
  if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'emailEnabled') is distinct from 'boolean'
    or coalesce(p_input->>'intervalMinutes','') !~ '^\d{1,5}$' then raise exception 'INVALID_INPUT|Choose a valid reminder interval.'; end if;
  enabled:=(p_input->>'enabled')::boolean; email_enabled:=(p_input->>'emailEnabled')::boolean; minutes:=(p_input->>'intervalMinutes')::integer;
  if minutes not between 15 and 10080 then raise exception 'INVALID_INPUT|Choose an interval from 15 minutes to 7 days.'; end if;
  insert into public.request_reminders(request_id,workspace_id,enabled,email_enabled,interval_minutes,review_id,next_due_at)
    values(r.id,r.workspace_id,enabled,email_enabled,minutes,
      case when enabled and not r.archived and r.status in ('ready_for_approval','partially_approved') then r.current_review_id end,
      case when enabled and not r.archived and r.status in ('ready_for_approval','partially_approved') then now()+make_interval(mins=>minutes) end)
    on conflict(request_id) do update set enabled=excluded.enabled,email_enabled=excluded.email_enabled,interval_minutes=excluded.interval_minutes,
      version=public.request_reminders.version+1,review_id=excluded.review_id,next_due_at=excluded.next_due_at;
  update public.reminder_emails set state='cancelled',payload=null where request_id=p_id and state in ('pending','sending','failed');
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(r.workspace_id,r.id,auth.uid(),'reminder_schedule_changed',r.current_revision);
  return public.request_reminders_get(p_id);
end; $$;

create function public.sync_request_reminders() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.archived or new.status not in ('ready_for_approval','partially_approved') then
    update public.request_reminders set review_id=null,next_due_at=null where request_id=new.id;
  elsif old.archived or old.status not in ('ready_for_approval','partially_approved') or old.current_review_id is distinct from new.current_review_id or old.current_revision<>new.current_revision then
    update public.request_reminders set review_id=new.current_review_id,next_due_at=now()+make_interval(mins=>interval_minutes),last_sent_at=null where request_id=new.id and enabled;
  end if;
  update public.reminder_emails set state='cancelled',payload=null where request_id=new.id and state in ('pending','sending','failed')
    and (review_id is distinct from new.current_review_id or not public.pending_review_recipient(new.id,recipient_id));
  update public.in_app_notifications set read_at=coalesce(read_at,now()) where request_id=new.id
    and (revision<>new.current_revision or not public.pending_review_recipient(new.id,recipient_id));
  return new;
end; $$;
create trigger request_reminder_transition after update of status,current_revision,current_review_id,archived on public.requests
  for each row execute function public.sync_request_reminders();

-- Preserve the existing one-time workspace default, excluding every author override, even paused ones.
create or replace function public.automation_remind_intake_core(p_workspace uuid) returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into public.in_app_notifications(workspace_id,recipient_id,request_id,revision,title)
    select r.workspace_id,m.user_id,r.id,r.current_revision,'Review waiting: '||left(v.fields->>'title',120)
    from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    join public.automation_policies p on p.workspace_id=r.workspace_id
    join public.memberships m on m.workspace_id=r.workspace_id
    where r.workspace_id=p_workspace and p.reminders and r.updated_at<=now()-interval '1 hour'*p.reminder_hours
      and not exists(select 1 from public.request_reminders x where x.request_id=r.id)
      and public.pending_review_recipient(r.id,m.user_id) on conflict do nothing;
  get diagnostics n=row_count;
  delete from public.automation_nonces where created_at<now()-interval '10 minutes';
  delete from public.automation_jobs j using public.workspaces w where j.workspace_id=w.id and w.id=p_workspace
    and j.created_at<now()-interval '1 day'*w.retention_days and j.state in ('ready','failed','outdated','cancelled') and cardinality(j.accepted)=0 and j.reviewed_by is null;
  return n;
end; $$;

create or replace function public.automation_remind(p_workspace uuid) returns integer language plpgsql security definer set search_path='' as $$
declare r public.requests; p public.request_reminders; recipient uuid; total integer:=0; before_count integer; feature_title text;
begin
  -- Lock the request first, matching approvals and author settings. Advance once, even after downtime.
  for r in select q.* from public.requests q join public.request_reminders x on x.request_id=q.id
    where q.workspace_id=p_workspace and x.enabled and x.next_due_at<=now() order by x.next_due_at,q.id for update of q skip locked limit 50 loop
    select * into p from public.request_reminders where request_id=r.id for update;
    if not p.enabled or p.next_due_at is null or p.next_due_at>now() then continue; end if;
    if r.archived or r.status not in ('ready_for_approval','partially_approved') or p.review_id is distinct from r.current_review_id then
      update public.request_reminders set next_due_at=null,review_id=null where request_id=r.id; continue;
    end if;
    select left(fields->>'title',120) into feature_title from public.request_revisions where request_id=r.id and number=r.current_revision;
    before_count:=total;
    for recipient in select m.user_id from public.memberships m where m.workspace_id=p_workspace and public.pending_review_recipient(r.id,m.user_id) loop
      insert into public.in_app_notifications(workspace_id,recipient_id,request_id,revision,title)
        values(r.workspace_id,recipient,r.id,r.current_revision,'Review waiting: '||feature_title)
        on conflict(recipient_id,request_id,revision) do update set read_at=null,created_at=now(),title=excluded.title;
      if p.email_enabled then
        insert into public.reminder_emails(workspace_id,request_id,review_id,recipient_id,cycle_at,plan_version)
          values(p_workspace,r.id,r.current_review_id,recipient,now(),p.version)
          on conflict(review_id,recipient_id) do update set delivery_key=gen_random_uuid(),cycle_at=now(),plan_version=p.version,
            state='pending',attempts=0,next_attempt=now(),lease_token=null,lease_until=null,last_error=null,payload=null
          where public.reminder_emails.state<>'sending' or public.reminder_emails.lease_until<=now();
      end if;
      total:=total+1;
    end loop;
    update public.request_reminders set next_due_at=now()+make_interval(mins=>interval_minutes),last_sent_at=case when total>before_count then now() else last_sent_at end where request_id=r.id;
  end loop;
  delete from public.intake_turns where workspace_id=p_workspace and created_at<now()-interval '1 day';
  delete from public.reminder_emails e using public.workspaces w where e.workspace_id=w.id and w.id=p_workspace
    and e.cycle_at<now()-interval '1 day'*w.retention_days and e.state in ('sent','failed','cancelled');
  return total+public.automation_remind_intake_core(p_workspace);
end; $$;

create function public.reminder_email_claim(p_workspace uuid,p_configured boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.reminder_emails; r public.requests; p public.request_reminders; address text;
begin
  if not p_configured then
    update public.reminder_emails set next_attempt=now()+interval '1 hour' where workspace_id=p_workspace and state='pending' and next_attempt<=now();
    return null;
  end if;
  select * into e from public.reminder_emails where workspace_id=p_workspace
    and ((state='pending' and next_attempt<=now()) or (state='sending' and lease_until<=now())) order by next_attempt,id limit 1;
  if e.id is null then return null; end if;
  select * into r from public.requests where id=e.request_id for update;
  select * into e from public.reminder_emails where id=e.id for update;
  if not ((e.state='pending' and e.next_attempt<=now()) or (e.state='sending' and e.lease_until<=now())) then return null; end if;
  select * into p from public.request_reminders where request_id=r.id;
  if not coalesce(p.enabled and p.email_enabled,false) or e.plan_version<>p.version or e.review_id is distinct from r.current_review_id
    or not public.pending_review_recipient(r.id,e.recipient_id) then
    update public.reminder_emails set state='cancelled',payload=null where id=e.id; return null;
  end if;
  if e.attempts>=3 or e.cycle_at<now()-interval '23 hours' then
    update public.reminder_emails set state='failed',last_error='The email retry window expired. The next reminder cycle will try again.',payload=null where id=e.id; return null;
  end if;
  select email into address from auth.users where id=e.recipient_id and email_confirmed_at is not null;
  if coalesce(address,'')='' then
    update public.reminder_emails set state='failed',last_error='The reviewer has no verified email address.',payload=null where id=e.id; return null;
  end if;
  if e.payload is not null and e.payload->>'to' is distinct from address then
    update public.reminder_emails set state='cancelled',last_error='The reviewer email changed. The next cycle will use the current address.',payload=null where id=e.id; return null;
  end if;
  update public.reminder_emails set state='sending',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',
    payload=coalesce(payload,jsonb_build_object('to',address,'title',(select left(fields->>'title',120) from public.request_revisions where request_id=r.id and number=r.current_revision),'requestId',r.id,'revision',r.current_revision))
    where id=e.id returning * into e;
  return jsonb_build_object('id',e.id,'deliveryKey',e.delivery_key,'leaseToken',e.lease_token,'payload',e.payload);
end; $$;

create function public.reminder_email_finish(p_id uuid,p_lease uuid,p_error text,p_retry boolean) returns void
language plpgsql security definer set search_path='' as $$
declare e public.reminder_emails;
begin
  select * into e from public.reminder_emails where id=p_id for update;
  if e.id is null or e.state<>'sending' or e.lease_token is distinct from p_lease or e.lease_until<=now() then return; end if;
  update public.reminder_emails set state=case when p_error is null then 'sent' when p_retry and attempts<3 then 'pending' else 'failed' end,
    next_attempt=now()+interval '1 minute'*attempts,last_error=left(p_error,300),
    last_sent_at=case when p_error is null then now() else last_sent_at end,
    payload=case when p_error is not null and p_retry and attempts<3 then payload else null end,
    lease_token=null,lease_until=null where id=e.id;
end; $$;

create function public.request_reminder_work_due(p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.request_reminders where workspace_id=p_workspace and enabled and next_due_at<=now())
    or exists(select 1 from public.reminder_emails where workspace_id=p_workspace and
      ((state='pending' and next_attempt<=now()) or (state='sending' and lease_until<=now())));
$$;

revoke execute on function public.pending_review_recipient(uuid,uuid),public.request_reminders_get(uuid),public.request_reminders_set(uuid,jsonb),
  public.sync_request_reminders(),public.automation_remind_intake_core(uuid),public.automation_remind(uuid),
  public.reminder_email_claim(uuid,boolean),public.reminder_email_finish(uuid,uuid,text,boolean),public.request_reminder_work_due(uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_reminders_get(uuid),public.request_reminders_set(uuid,jsonb) to authenticated;
grant execute on function public.automation_remind(uuid),public.reminder_email_claim(uuid,boolean),public.reminder_email_finish(uuid,uuid,text,boolean) to service_role;

-- Update an existing configured dispatcher without reading or replacing its Vault secret.
do $$ declare definition text; marker text:='if not coalesce(remind,false) and not coalesce(maintenance,false) and not exists'; begin
  if to_regprocedure('handoff_internal.dispatch_automation()') is not null then
    select pg_get_functiondef(to_regprocedure('handoff_internal.dispatch_automation()')) into definition;
    if position(marker in definition)=0 then raise exception 'The installed dispatcher differs from the expected template. Review it before installing repeating reminders.'; end if;
    execute replace(definition,marker,'if not coalesce(remind,false) and not coalesce(maintenance,false) and not public.request_reminder_work_due(w) and not exists');
  end if;
end; $$;
commit;
