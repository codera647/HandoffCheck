begin;

-- Credentials and OAuth state are service-only. Browser RPCs expose connection metadata only.
create table public.gmail_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id),
  generation integer not null default 0,
  email text, google_sub text, encrypted_refresh_token text,
  last_error text, connected_at timestamptz
);
create table public.gmail_oauth_states (
  state_hash text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id), generation integer not null,
  expected_email text not null, expected_sub text not null, encrypted_verifier text not null,
  return_url text not null, expires_at timestamptz not null default now()+interval '10 minutes'
);
create index gmail_states_expiry on public.gmail_oauth_states(expires_at);
alter table public.gmail_connections enable row level security;
alter table public.gmail_oauth_states enable row level security;
revoke all on public.gmail_connections,public.gmail_oauth_states from public,anon,authenticated;
grant all on public.gmail_connections,public.gmail_oauth_states to service_role;

create function public.gmail_oauth_start(p_actor uuid,p_request uuid,p_hash text,p_email text,p_sub text,p_verifier text,p_return text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.requests; g integer;
begin
  select * into r from public.requests where id=p_request;
  if r.author_id is distinct from p_actor or not exists(select 1 from public.memberships where user_id=p_actor and workspace_id=r.workspace_id and status='active')
    or not exists(select 1 from auth.users where id=p_actor and lower(email)=p_email and email_confirmed_at is not null) then
    raise exception 'FORBIDDEN|Only an active request author can connect their verified Google account.';
  end if;
  insert into public.gmail_connections(user_id,workspace_id,generation) values(p_actor,r.workspace_id,1)
    on conflict(user_id) do update set generation=public.gmail_connections.generation+1 returning generation into g;
  delete from public.gmail_oauth_states where user_id=p_actor or expires_at<now();
  insert into public.gmail_oauth_states(state_hash,user_id,workspace_id,generation,expected_email,expected_sub,encrypted_verifier,return_url)
    values(p_hash,p_actor,r.workspace_id,g,p_email,p_sub,p_verifier,p_return);
end; $$;

create function public.gmail_oauth_consume(p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.gmail_oauth_states;
begin
  delete from public.gmail_oauth_states where state_hash=p_hash returning * into s;
  if s.state_hash is null or s.expires_at<=now() then return null; end if;
  if not exists(select 1 from public.gmail_connections where user_id=s.user_id and workspace_id=s.workspace_id and generation=s.generation)
    or not exists(select 1 from public.memberships where user_id=s.user_id and workspace_id=s.workspace_id and status='active') then return null; end if;
  return to_jsonb(s);
end; $$;

create function public.gmail_oauth_complete(p_actor uuid,p_generation integer,p_email text,p_sub text,p_token text) returns boolean
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  update public.gmail_connections g set email=p_email,google_sub=p_sub,encrypted_refresh_token=p_token,last_error=null,connected_at=now()
    where g.user_id=p_actor and g.generation=p_generation
      and exists(select 1 from public.memberships where user_id=p_actor and workspace_id=g.workspace_id and status='active')
      and exists(select 1 from auth.users where id=p_actor and lower(email)=p_email and email_confirmed_at is not null);
  get diagnostics n=row_count;
  return n=1;
end; $$;

create function public.gmail_disconnect() returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  update public.gmail_connections set encrypted_refresh_token=null,email=null,google_sub=null,last_error=null,connected_at=null,generation=generation+1 where user_id=auth.uid() and workspace_id=w;
  delete from public.gmail_oauth_states where user_id=auth.uid();
  update public.reminder_emails e set state='cancelled',payload=null where e.request_id in(select id from public.requests where author_id=auth.uid() and workspace_id=w) and state in ('pending','sending','failed');
end; $$;

create function public.gmail_connection_invalid(p_actor uuid,p_generation integer) returns void
language sql security definer set search_path='' as $$
  update public.gmail_connections set encrypted_refresh_token=null,last_error='Google permission expired or was revoked. Connect Gmail again.' where user_id=p_actor and generation=p_generation;
$$;

alter table public.reminder_emails drop constraint reminder_emails_state_check;
alter table public.reminder_emails add constraint reminder_emails_state_check check(state in ('pending','sending','sent','failed','cancelled','uncertain'));
alter table public.reminder_emails add column send_started_at timestamptz;
alter table public.reminder_emails add column sender_generation integer;
-- A fresh regular cycle can send again; an abandoned in-flight attempt cannot be retried.
do $$ declare definition text; begin
  select pg_get_functiondef('public.automation_remind(uuid)'::regprocedure) into definition;
  if position('lease_token=null,lease_until=null,last_error=null,payload=null' in definition)=0 then
    raise exception 'Review the installed reminder scheduler before changing its transport.';
  end if;
  definition:=replace(definition,'lease_token=null,lease_until=null,last_error=null,payload=null',
    'lease_token=null,lease_until=null,last_error=null,payload=null,send_started_at=null,sender_generation=null');
  execute replace(definition,'e.state in (''sent'',''failed'',''cancelled'')','e.state in (''sent'',''failed'',''cancelled'',''uncertain'')');
end; $$;
-- Never carry a shared-sender attempt into an author-mailbox delivery.
update public.reminder_emails set state='cancelled',payload=null where state in ('pending','sending','failed');

create or replace function public.request_reminders_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.requests; p public.request_reminders; g public.gmail_connections; email_state text; last_email timestamptz;
begin
  perform public.assert_request_access(p_id);
  select * into r from public.requests where id=p_id;
  select * into p from public.request_reminders where request_id=p_id;
  select * into g from public.gmail_connections where user_id=r.author_id and workspace_id=r.workspace_id;
  select case when bool_or(state='uncertain') then 'uncertain' when bool_or(state='failed') then 'failed' when bool_or(state='sending') then 'sending'
    when bool_or(state='pending') then 'queued' when bool_or(state='sent') then 'sent' else 'waiting' end,max(last_sent_at)
    into email_state,last_email from public.reminder_emails where request_id=p_id and review_id=r.current_review_id and plan_version=p.version;
  return jsonb_build_object('enabled',coalesce(p.enabled,false),'emailEnabled',coalesce(p.email_enabled,true),
    'intervalMinutes',coalesce(p.interval_minutes,1440),'version',coalesce(p.version,0),'custom',p.request_id is not null,
    'state',case when not coalesce(p.enabled,false) then 'off' when r.archived or r.status in ('approved','brief_ready') then 'stopped'
      when p.next_due_at is not null then 'scheduled' else 'waiting' end,
    'nextDueAt',p.next_due_at,'lastSentAt',p.last_sent_at,'lastEmailSentAt',last_email,
    'senderConnected',g.encrypted_refresh_token is not null,'senderEmail',g.email,
    'senderError',case when auth.uid()=r.author_id then g.last_error end,
    'emailStatus',case when not coalesce(p.enabled,false) or not coalesce(p.email_enabled,false) then 'off' else coalesce(email_state,'waiting') end);
end; $$;

-- Reuse the existing eligibility rules and lock order; Gmail has no send idempotency contract.
create or replace function public.reminder_email_claim(p_workspace uuid,p_configured boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.reminder_emails; r public.requests; p public.request_reminders; c public.gmail_connections; address text;
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
  if e.state='sending' and e.send_started_at is not null then
    update public.reminder_emails set state='uncertain',payload=null,last_error='Gmail delivery could not be confirmed. This cycle will not be resent.',lease_token=null,lease_until=null where id=e.id; return null;
  end if;
  select * into p from public.request_reminders where request_id=r.id;
  if not coalesce(p.enabled and p.email_enabled,false) or e.plan_version<>p.version or e.review_id is distinct from r.current_review_id
    or not public.pending_review_recipient(r.id,e.recipient_id) then
    update public.reminder_emails set state='cancelled',payload=null where id=e.id; return null;
  end if;
  select * into c from public.gmail_connections where user_id=r.author_id and workspace_id=p_workspace;
  if c.encrypted_refresh_token is null or not exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=r.author_id and status='active')
    or not exists(select 1 from auth.users where id=r.author_id and lower(email)=c.email and email_confirmed_at is not null) then
    update public.reminder_emails set state='failed',payload=null,last_error='The author must connect Gmail before email reminders can be sent.' where id=e.id; return null;
  end if;
  if e.attempts>=3 or e.cycle_at<now()-interval '23 hours' then
    update public.reminder_emails set state='failed',last_error='The email retry window expired. The next reminder cycle will try again.',payload=null where id=e.id; return null;
  end if;
  select email into address from auth.users where id=e.recipient_id and email_confirmed_at is not null;
  if coalesce(address,'')='' then
    update public.reminder_emails set state='failed',last_error='The reviewer has no verified email address.',payload=null where id=e.id; return null;
  end if;
  if e.payload is not null and (e.payload->>'to' is distinct from address or e.payload->>'from' is distinct from c.email) then
    update public.reminder_emails set state='cancelled',last_error='The sender or reviewer email changed. The next cycle will use the current address.',payload=null where id=e.id; return null;
  end if;
  update public.reminder_emails set state='sending',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',send_started_at=null,sender_generation=c.generation,
    payload=coalesce(payload,jsonb_build_object('to',address,'from',c.email,'title',(select left(fields->>'title',120) from public.request_revisions where request_id=r.id and number=r.current_revision),'requestId',r.id,'revision',r.current_revision))
    where id=e.id returning * into e;
  return jsonb_build_object('id',e.id,'deliveryKey',e.delivery_key,'leaseToken',e.lease_token,'payload',e.payload,
    'senderId',r.author_id,'generation',c.generation,'googleSub',c.google_sub,'encryptedToken',c.encrypted_refresh_token);
end; $$;

create function public.gmail_email_begin_send(p_id uuid,p_lease uuid,p_generation integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.reminder_emails; r public.requests; p public.request_reminders;
begin
  select * into e from public.reminder_emails where id=p_id;
  select * into r from public.requests where id=e.request_id for update;
  select * into e from public.reminder_emails where id=p_id for update;
  select * into p from public.request_reminders where request_id=r.id;
  if e.state is distinct from 'sending' or e.lease_token is distinct from p_lease or e.lease_until<=now() or e.send_started_at is not null then return false; end if;
  if not coalesce(p.enabled and p.email_enabled,false) or p.version<>e.plan_version or r.current_review_id is distinct from e.review_id
    or not public.pending_review_recipient(r.id,e.recipient_id)
    or not exists(select 1 from public.gmail_connections c join auth.users u on u.id=c.user_id
      join public.memberships m on m.user_id=c.user_id and m.workspace_id=c.workspace_id and m.status='active'
      where c.user_id=r.author_id and c.workspace_id=r.workspace_id and c.generation=p_generation and c.generation=e.sender_generation
        and c.encrypted_refresh_token is not null and c.email=e.payload->>'from' and lower(u.email)=c.email and u.email_confirmed_at is not null)
    or not exists(select 1 from auth.users where id=e.recipient_id and email=e.payload->>'to' and email_confirmed_at is not null) then
    update public.reminder_emails set state='cancelled',payload=null where id=p_id; return false;
  end if;
  update public.reminder_emails set send_started_at=now() where id=p_id; return true;
end; $$;

drop function public.reminder_email_finish(uuid,uuid,text,boolean);
create function public.reminder_email_finish(p_id uuid,p_lease uuid,p_error text,p_retry boolean,p_uncertain boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare e public.reminder_emails;
begin
  select * into e from public.reminder_emails where id=p_id for update;
  if e.id is null or e.state<>'sending' or e.lease_token is distinct from p_lease or e.lease_until<=now() then return; end if;
  if p_error is null and e.send_started_at is null then raise exception 'Email sending was not started.'; end if;
  update public.reminder_emails set state=case when p_uncertain then 'uncertain' when p_error is null then 'sent' when p_retry and attempts<3 then 'pending' else 'failed' end,
    next_attempt=now()+interval '1 minute'*attempts,last_error=left(p_error,300),
    last_sent_at=case when p_error is null and not p_uncertain then now() else last_sent_at end,
    payload=case when not p_uncertain and p_error is not null and p_retry and attempts<3 then payload else null end,
    send_started_at=case when p_retry and not p_uncertain then null else send_started_at end,
    lease_token=null,lease_until=null where id=e.id;
end; $$;

revoke execute on function public.gmail_oauth_start(uuid,uuid,text,text,text,text,text),public.gmail_oauth_consume(text),public.gmail_oauth_complete(uuid,integer,text,text,text),
  public.gmail_disconnect(),public.gmail_connection_invalid(uuid,integer),public.gmail_email_begin_send(uuid,uuid,integer),public.reminder_email_finish(uuid,uuid,text,boolean,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.gmail_disconnect() to authenticated;
grant execute on function public.gmail_oauth_start(uuid,uuid,text,text,text,text,text),public.gmail_oauth_consume(text),public.gmail_oauth_complete(uuid,integer,text,text,text),
  public.gmail_connection_invalid(uuid,integer),public.gmail_email_begin_send(uuid,uuid,integer),public.reminder_email_finish(uuid,uuid,text,boolean,boolean) to service_role;

commit;
