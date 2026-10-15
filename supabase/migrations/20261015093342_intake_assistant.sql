begin;
alter table public.ai_usage add column purpose text not null default 'automation' check(purpose in ('automation','probe','intake'));
update public.ai_usage set purpose='probe' where job_id is null;

-- Short-lived, author-only response receipts. No request exists until the author saves the form.
create table public.intake_turns (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null references auth.users(id), command_key uuid not null, input_hash text not null,
  state text not null default 'working' check(state in ('working','ready','failed')),
  response jsonb, error text, model text, policy_version integer not null,
  usage_id uuid not null references public.ai_usage(id), lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now()+interval '90 seconds', created_at timestamptz not null default now(),
  unique(workspace_id,actor_id,command_key)
);
create index intake_actor_time on public.intake_turns(workspace_id,actor_id,created_at);
alter table public.intake_turns enable row level security;
revoke all on public.intake_turns from public,anon,authenticated;
grant all on public.intake_turns to service_role;

create function public.intake_claim(p_key uuid,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p public.automation_policies; t public.intake_turns; usage uuid;
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_member(w) then raise exception 'ACCESS_DENIED|Your workspace access is unavailable.'; end if;
  select * into p from public.automation_policies where workspace_id=w;
  if p.workspace_id is null or (select review_mode from public.workspaces where id=w)<>'ai' then
    raise exception 'AI_DISABLED|Enable AI in Automation settings to use the request assistant.';
  end if;
  if p_key is null or p_input is null or octet_length(p_input::text)>48000 then raise exception 'INVALID_INPUT|Keep the conversation below 48 KB.'; end if;
  delete from public.intake_turns where workspace_id=w and created_at<now()-interval '1 day';
  select * into t from public.intake_turns where workspace_id=w and actor_id=auth.uid() and command_key=p_key;
  if t.id is not null then
    if t.input_hash<>public.json_hash(p_input) then raise exception 'KEY_REUSED|This message key was used for different text.'; end if;
    if t.state='working' and t.lease_until<=now() then
      update public.intake_turns set state='failed',error='The assistant turn timed out. Retry this message.' where id=t.id returning * into t;
    end if;
    if t.state='working' then raise exception 'CHAT_RUNNING|This message is still being processed. Wait before checking again.'; end if;
    return jsonb_build_object('created',false,'state',t.state,'response',t.response,'error',t.error,'model',t.model);
  end if;
  if exists(select 1 from public.intake_turns where workspace_id=w and actor_id=auth.uid() and state='working' and lease_until>now()) then
    raise exception 'CHAT_RUNNING|Your previous message is still being processed.';
  end if;
  if (select count(*) from public.intake_turns where workspace_id=w and state='working' and lease_until>now())+
    (select count(*) from public.automation_jobs where workspace_id=w and state='working' and lease_until>now())>=2 then
    raise exception 'RATE_LIMIT|The request assistant is busy. Try again shortly.';
  end if;
  if (select count(*) from public.ai_usage where workspace_id=w and created_at>=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'))>=p.daily_limit then
    raise exception 'RATE_LIMIT|The workspace daily AI limit has been reached. You can still fill the form manually.';
  end if;
  if (select count(*) from public.ai_usage where workspace_id=w and actor_id=auth.uid() and created_at>now()-interval '1 hour')>=10 then
    raise exception 'RATE_LIMIT|Your hourly AI attempt limit has been reached. You can still fill the form manually.';
  end if;
  insert into public.ai_usage(workspace_id,actor_id,attempt,purpose) values(w,auth.uid(),1,'intake') returning id into usage;
  insert into public.intake_turns(workspace_id,actor_id,command_key,input_hash,policy_version,usage_id)
    values(w,auth.uid(),p_key,public.json_hash(p_input),p.version,usage) returning * into t;
  return jsonb_build_object('created',true,'id',t.id,'leaseToken',t.lease_token);
end; $$;
create function public.intake_finish(p_id uuid,p_actor uuid,p_lease uuid,p_response jsonb,p_error text,p_model text,p_usage jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.intake_turns;
begin
  select * into t from public.intake_turns where id=p_id;
  perform 1 from public.workspaces where id=t.workspace_id for update;
  select * into t from public.intake_turns where id=p_id for update;
  if t.id is null or t.actor_id<>p_actor or t.state<>'working' or t.lease_token<>p_lease or t.lease_until<=now() then
    raise exception 'INVALID_LEASE|The assistant turn expired. Retry this message.';
  end if;
  if not exists(select 1 from public.memberships where workspace_id=t.workspace_id and user_id=p_actor and status='active')
    or not exists(select 1 from public.workspaces where id=t.workspace_id and review_mode='ai')
    or t.policy_version<>(select version from public.automation_policies where workspace_id=t.workspace_id) then
    update public.intake_turns set state='failed',response=null,error='Access or AI settings changed. Start a new turn.' where id=t.id;
    raise exception 'ACCESS_DENIED|Access or AI settings changed. Reload before continuing.';
  end if;
  if p_error is null and (p_response is null or octet_length(p_response::text)>40000) then raise exception 'INVALID_AI_OUTPUT|The proposed draft could not be stored.'; end if;
  update public.ai_usage set model=p_model,
    input_tokens=case when p_usage->>'inputTokens' ~ '^\d{1,8}$' then (p_usage->>'inputTokens')::integer end,
    output_tokens=case when p_usage->>'outputTokens' ~ '^\d{1,8}$' then (p_usage->>'outputTokens')::integer end where id=t.usage_id;
  update public.intake_turns set state=case when p_error is null then 'ready' else 'failed' end,
    response=case when p_error is null then p_response end,error=left(p_error,500),model=p_model where id=t.id returning * into t;
  return jsonb_build_object('state',t.state,'response',t.response,'error',t.error,'model',t.model);
end; $$;

-- Probe throttling stays separate while all AI purposes share the daily budget.
create or replace function public.automation_reserve_probe() returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p public.automation_policies;
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  select * into p from public.automation_policies where workspace_id=w;
  if (select count(*) from public.ai_usage where workspace_id=w and created_at>=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'))>=coalesce(p.daily_limit,50)
    or exists(select 1 from public.ai_usage where workspace_id=w and actor_id=auth.uid() and purpose='probe' and created_at>now()-interval '1 hour') then raise exception 'RATE_LIMIT|Provider checks are limited to one per hour and the workspace daily budget.'; end if;
  insert into public.ai_usage(workspace_id,actor_id,attempt,purpose) values(w,auth.uid(),1,'probe');
end; $$;
alter function public.automation_remind(uuid) rename to automation_remind_intake_core;
create function public.automation_remind(p_workspace uuid) returns integer language plpgsql security definer set search_path='' as $$
begin
  delete from public.intake_turns where workspace_id=p_workspace and created_at<now()-interval '1 day';
  return public.automation_remind_intake_core(p_workspace);
end; $$;
revoke execute on function public.intake_claim(uuid,jsonb),public.intake_finish(uuid,uuid,uuid,jsonb,text,text,jsonb),public.automation_remind(uuid),public.automation_remind_intake_core(uuid) from public,anon,authenticated,service_role;
grant execute on function public.intake_claim(uuid,jsonb) to authenticated;
grant execute on function public.intake_finish(uuid,uuid,uuid,jsonb,text,text,jsonb),public.automation_remind(uuid) to service_role;

-- Chat turns and queued jobs share the same two-call workspace concurrency limit.
alter function public.automation_claim(uuid,uuid) rename to automation_claim_intake_core;
create function public.automation_claim(p_workspace uuid,p_job uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare request uuid;
begin
  select j.request_id into request from public.automation_jobs j where j.workspace_id=p_workspace and (p_job is null or j.id=p_job)
    and ((j.state='queued' and j.next_attempt<=now()) or (j.state='working' and j.lease_until<=now())) order by j.created_at limit 1;
  if request is null then return null; end if;
  perform 1 from public.requests where id=request for update;
  perform 1 from public.workspaces where id=p_workspace for update;
  if (select count(*) from public.intake_turns where workspace_id=p_workspace and state='working' and lease_until>now())+
    (select count(*) from public.automation_jobs where workspace_id=p_workspace and state='working' and lease_until>now())>=2 then return null; end if;
  return public.automation_claim_intake_core(p_workspace,p_job);
end; $$;
revoke execute on function public.automation_claim_intake_core(uuid,uuid),public.automation_claim(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.automation_claim(uuid,uuid) to service_role;
commit;
