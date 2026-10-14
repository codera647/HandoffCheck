-- AI results are separate artifacts. Workflow permissions stay in the canonical commands.
create table public.automation_policies (
  workspace_id uuid primary key references public.workspaces(id), version integer not null default 1,
  suggestions boolean not null default false, summaries boolean not null default false, qa boolean not null default false,
  background boolean not null default false, auto_brief boolean not null default false, reminders boolean not null default false,
  reminder_hours integer not null default 24 check(reminder_hours between 1 and 168),
  daily_limit integer not null default 50 check(daily_limit between 1 and 50),
  changed_by uuid references auth.users(id), changed_at timestamptz not null default now()
);
insert into public.automation_policies(workspace_id) select id from public.workspaces;
create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  request_id uuid not null references public.requests(id), actor_id uuid not null references auth.users(id),
  kind text not null check(kind in ('review','edits','summary','qa')), revision integer not null,
  input_hash text not null, brief_id uuid references public.briefs(id), review_id uuid references public.review_runs(id),
  policy_version integer not null, state text not null default 'queued' check(state in ('queued','working','ready','failed','outdated','cancelled')),
  output jsonb, error text, model text, attempts integer not null default 0 check(attempts between 0 and 3),
  lease_token uuid, lease_until timestamptz, next_attempt timestamptz not null default now(),
  created_at timestamptz not null default now(), accepted integer[] not null default '{}', reviewed_by uuid references auth.users(id),
  foreign key(request_id,revision) references public.request_revisions(request_id,number)
);
create unique index automation_one_active_source on public.automation_jobs(request_id,kind,revision,coalesce(brief_id,'00000000-0000-0000-0000-000000000000')) where state in ('queued','working','ready');
create index automation_due on public.automation_jobs(workspace_id,next_attempt) where state in ('queued','working');
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  job_id uuid references public.automation_jobs(id) on delete cascade, actor_id uuid not null references auth.users(id),
  attempt integer not null, model text, input_tokens integer check(input_tokens>=0), output_tokens integer check(output_tokens>=0),
  created_at timestamptz not null default now(), unique(job_id,attempt)
);
create index ai_usage_budget on public.ai_usage(workspace_id,created_at);
create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  recipient_id uuid not null references auth.users(id), request_id uuid not null references public.requests(id),
  revision integer not null, title text not null, read_at timestamptz, created_at timestamptz not null default now(),
  unique(recipient_id,request_id,revision)
);
create index notification_recipient on public.in_app_notifications(workspace_id,recipient_id,created_at);
create table public.automation_nonces (nonce uuid primary key, created_at timestamptz not null default now());
alter table public.automation_policies enable row level security;
alter table public.automation_jobs enable row level security;
alter table public.ai_usage enable row level security;
alter table public.in_app_notifications enable row level security;
alter table public.automation_nonces enable row level security;
-- Jobs contain private worker leases; clients read only the sanitized RPC projection.
create policy automation_policy_read on public.automation_policies for select to authenticated using(public.is_member(workspace_id));
create policy notification_read on public.in_app_notifications for select to authenticated using(recipient_id=auth.uid() and public.is_member(workspace_id));
grant select on public.automation_policies, public.in_app_notifications to authenticated;
grant all on public.automation_policies,public.automation_jobs,public.ai_usage,public.in_app_notifications,public.automation_nonces to service_role;

create function public.automation_policy() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p public.automation_policies;
begin
  insert into public.automation_policies(workspace_id) values(w) on conflict do nothing;
  select * into p from public.automation_policies where workspace_id=w;
  return jsonb_build_object('version',p.version,'aiEnabled',(select review_mode='ai' from public.workspaces where id=w),
    'suggestions',p.suggestions,'summaries',p.summaries,'qa',p.qa,'background',p.background,'autoBrief',p.auto_brief,
    'reminders',p.reminders,'reminderHours',p.reminder_hours,'dailyLimit',p.daily_limit);
end; $$;
create function public.automation_set_policy(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p public.automation_policies; b text;
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  insert into public.automation_policies(workspace_id) values(w) on conflict do nothing;
  select * into p from public.automation_policies where workspace_id=w for update;
  if p_input->>'expectedVersion' is null or (p_input->>'expectedVersion')::integer<>p.version then raise exception 'POLICY_CHANGED|Automation settings changed. Reload before saving.'; end if;
  foreach b in array array['aiEnabled','suggestions','summaries','qa','background','autoBrief','reminders'] loop
    if jsonb_typeof(p_input->b) is distinct from 'boolean' then raise exception 'INVALID_INPUT|Choose valid automation settings.'; end if;
  end loop;
  if (p_input->>'dailyLimit')::integer not between 1 and 50 or (p_input->>'reminderHours')::integer not between 1 and 168 or p_input->>'dailyLimit' is null or p_input->>'reminderHours' is null then raise exception 'INVALID_INPUT|Choose valid limits.'; end if;
  update public.automation_policies set version=version+1,suggestions=(p_input->>'suggestions')::boolean,summaries=(p_input->>'summaries')::boolean,
    qa=(p_input->>'qa')::boolean,background=(p_input->>'background')::boolean,auto_brief=(p_input->>'autoBrief')::boolean,
    reminders=(p_input->>'reminders')::boolean,reminder_hours=(p_input->>'reminderHours')::integer,daily_limit=(p_input->>'dailyLimit')::integer,
    changed_by=auth.uid(),changed_at=now() where workspace_id=w;
  update public.workspaces set review_mode=case when (p_input->>'aiEnabled')::boolean then 'ai' else 'checklist_only' end where id=w;
  insert into public.audit_events(workspace_id,actor_id,action) values(w,auth.uid(),'automation_policy_changed');
  return public.automation_policy();
end; $$;
create function public.automation_job_json(j public.automation_jobs) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'requestId',j.request_id,'actorId',j.actor_id,'kind',j.kind,'revision',j.revision,
    'inputHash',j.input_hash,'briefId',j.brief_id,'state',j.state,'output',j.output,'error',j.error,'attempts',j.attempts,
    'createdAt',j.created_at,'accepted',to_jsonb(j.accepted),'reviewedBy',j.reviewed_by,'demo',false,'model',j.model);
$$;
create function public.automation_tasks(p_request uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  if not exists(select 1 from public.requests where id=p_request and workspace_id=w) then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  return coalesce((select jsonb_agg(public.automation_job_json(j) order by j.created_at desc) from (select * from public.automation_jobs where request_id=p_request and workspace_id=w order by created_at desc limit 30) j),'[]');
end; $$;
create function public.automation_request(p_request uuid,p_kind text,p_expected integer,p_brief uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); r public.requests; v public.request_revisions; p public.automation_policies; j public.automation_jobs; b public.briefs;
begin
  select * into r from public.requests where id=p_request and workspace_id=w for update;
  if r.id is null then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  perform 1 from public.workspaces where id=w for update;
  if not public.is_member(w) then raise exception 'FORBIDDEN|Active workspace membership is required.'; end if;
  if r.archived then raise exception 'ARCHIVED|Restore the request before requesting assistance.'; end if;
  select * into p from public.automation_policies where workspace_id=w;
  if (select review_mode from public.workspaces where id=w)<>'ai' or p.workspace_id is null or
     not (case p_kind when 'edits' then p.suggestions when 'summary' then p.summaries when 'qa' then p.qa else false end)
    then raise exception 'AI_DISABLED|This assistance feature is disabled. Ask your administrator.'; end if;
  if p_kind='qa' then
    select * into b from public.briefs where id=p_brief and request_id=r.id and workspace_id=w;
    if b.id is null or b.revision<>p_expected then raise exception 'NOT_APPROVED|Choose a stored approved brief.'; end if;
    select * into v from public.request_revisions where request_id=r.id and number=b.revision;
  else
    perform public.assert_revision(r,p_expected);
    select * into v from public.request_revisions where request_id=r.id and number=r.current_revision;
    if auth.uid()<>r.author_id and not public.is_assigned(r,v) then raise exception 'FORBIDDEN|Only the author or assigned leads can request this assistance.'; end if;
    if p_brief is not null then raise exception 'INVALID_INPUT|A brief is only used for QA drafts.'; end if;
  end if;
  select * into j from public.automation_jobs where request_id=r.id and kind=p_kind and revision=v.number and brief_id is not distinct from p_brief and state in ('queued','working','ready') order by created_at desc limit 1;
  if j.id is not null then return public.automation_job_json(j); end if;
  if (select count(*) from public.automation_jobs where workspace_id=w and actor_id=auth.uid() and created_at>now()-interval '1 hour')>=10 then raise exception 'RATE_LIMIT|The assistance limit has been reached. Try later.'; end if;
  insert into public.automation_jobs(workspace_id,request_id,actor_id,kind,revision,input_hash,brief_id,policy_version)
    values(w,r.id,auth.uid(),p_kind,v.number,v.input_hash,p_brief,p.version) returning * into j;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(w,r.id,auth.uid(),'request_ai_'||p_kind,v.number);
  return public.automation_job_json(j);
end; $$;

-- Canonical command remains the sole writer of requirement revisions and approved briefs.
alter function public.handoff_command(uuid,jsonb,text) rename to handoff_command_core;
revoke execute on function public.handoff_command_core(uuid,jsonb,text) from public,anon,authenticated;
create function public.handoff_command(p_id uuid,p_command jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; p public.automation_policies;
begin
  result:=public.handoff_command_core(p_id,p_command,p_key);
  select * into p from public.automation_policies where workspace_id=(result->>'workspaceId')::uuid;
  if p_command->>'action'='approve' and result->>'status'='approved' and p.auto_brief then
    result:=public.handoff_command_core(p_id,jsonb_build_object('action','generate','expectedRevision',(result->>'currentRevision')::integer),left(p_key,100)||':auto-brief');
  end if;
  update public.automation_jobs set state='outdated',error='The request changed. Generate assistance for the current revision.'
    where request_id=p_id and kind<>'qa' and revision<>(result->>'currentRevision')::integer and state in ('queued','working','ready');
  return result;
end; $$;

-- Queue review after the existing transaction has authorized and captured its lease.
alter function public.handoff_start_review(uuid,integer,text) rename to handoff_start_review_core;
revoke execute on function public.handoff_start_review_core(uuid,integer,text) from public,anon,authenticated;
create function public.handoff_start_review(p_id uuid,p_expected integer,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; r public.requests; p public.automation_policies; job uuid;
begin
  result:=public.handoff_start_review_core(p_id,p_expected,p_key);
  if coalesce((result->>'claimed')::boolean,false) then
    select * into r from public.requests where id=p_id;
    insert into public.automation_policies(workspace_id) values(r.workspace_id) on conflict do nothing;
    select * into p from public.automation_policies where workspace_id=r.workspace_id;
    if exists(select 1 from public.findings where review_id=(result->>'runId')::uuid and body->>'origin'='deterministic') then
      update public.review_runs set state='succeeded' where id=(result->>'runId')::uuid;
      update public.requests set status='needs_clarification' where id=p_id;
      return jsonb_build_object('record',public.handoff_get(p_id),'claimed',false);
    end if;
    update public.automation_jobs set state='outdated',error='A newer review replaced this run.' where request_id=p_id and kind='review' and state in ('queued','working','ready');
    insert into public.automation_jobs(workspace_id,request_id,actor_id,kind,revision,input_hash,review_id,policy_version)
      values(r.workspace_id,r.id,auth.uid(),'review',p_expected,result->'revision'->>'inputHash',(result->>'runId')::uuid,p.version) returning id into job;
    return jsonb_build_object('record',public.handoff_get(p_id),'claimed',false,'queued',true,'jobId',job);
  end if;
  return result;
end; $$;

create function public.automation_actor_allowed(j public.automation_jobs) returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=j.revision
    join public.memberships m on m.workspace_id=r.workspace_id and m.user_id=j.actor_id and m.status='active'
    join public.workspaces w on w.id=r.workspace_id join public.automation_policies p on p.workspace_id=w.id
    where r.id=j.request_id and r.workspace_id=j.workspace_id and not r.archived and w.review_mode='ai' and p.version=j.policy_version
    and v.input_hash=j.input_hash and (j.kind='qa' and p.qa and exists(select 1 from public.briefs b where b.id=j.brief_id and b.request_id=r.id and b.revision=v.number)
      or j.kind<>'qa' and r.current_revision=j.revision and (m.user_id=r.author_id or m.role='product_lead' and m.user_id=v.product_reviewer_id or m.role='engineering_lead' and m.user_id=v.engineering_reviewer_id)
      and case j.kind when 'edits' then p.suggestions when 'summary' then p.summaries when 'review' then r.current_review_id=j.review_id and exists(select 1 from public.review_runs x where x.id=j.review_id and x.state='running' and x.input_hash=j.input_hash) else false end));
$$;
create function public.automation_claim(p_workspace uuid,p_job uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.automation_jobs; candidate uuid; r public.requests; p public.automation_policies; v public.request_revisions;
begin
  select id into candidate from public.automation_jobs where workspace_id=p_workspace and (p_job is null or id=p_job) and ((state='queued' and next_attempt<=now()) or (state='working' and lease_until<=now())) order by created_at limit 1;
  if candidate is null then return null; end if;
  select * into j from public.automation_jobs where id=candidate;
  select * into r from public.requests where id=j.request_id for update;
  perform 1 from public.workspaces where id=p_workspace for update;
  select * into j from public.automation_jobs where id=candidate for update;
  if not (j.state='queued' and j.next_attempt<=now() or j.state='working' and j.lease_until<=now()) then return null; end if;
  if not public.automation_actor_allowed(j) then
    update public.automation_jobs set state=case when r.current_revision<>j.revision and j.kind<>'qa' then 'outdated' else 'cancelled' end,error='Source, access or automation policy changed.' where id=j.id;
    if j.kind='review' and exists(select 1 from public.review_runs where id=j.review_id and state='running') then perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),null,'AI review was cancelled. Review again using current settings.',null); end if;
    return null;
  end if;
  select * into p from public.automation_policies where workspace_id=p_workspace;
  if j.attempts>=3 then
    update public.automation_jobs set state='failed',error='The task could not finish after three attempts. Try again.' where id=j.id;
    if j.kind='review' then perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),null,'AI review could not finish. Try again.',null); end if;
    return null;
  end if;
  if (select count(*) from public.ai_usage where workspace_id=p_workspace and created_at>=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'))>=p.daily_limit then
    update public.automation_jobs set next_attempt=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC')+interval '1 day',state='queued' where id=j.id;
    if j.kind='review' then
      update public.automation_jobs set state='failed',error='The daily AI limit has been reached. Review again tomorrow.' where id=j.id;
      perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),null,'The daily AI limit has been reached. Review again tomorrow.',null);
    end if;
    return null;
  end if;
  if (select count(*) from public.automation_jobs where workspace_id=p_workspace and state='working' and lease_until>now())>=2 then return null; end if;
  if (select count(*) from public.ai_usage where workspace_id=p_workspace and actor_id=j.actor_id and created_at>now()-interval '1 hour')>=10 then
    update public.automation_jobs set state='failed',error='The hourly AI attempt limit has been reached. Try later.' where id=j.id;
    if j.kind='review' then perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),null,'The hourly AI attempt limit has been reached. Try later.',null); end if;
    return null;
  end if;
  update public.automation_jobs set state='working',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',error=null where id=j.id returning * into j;
  if j.kind='review' then update public.review_runs set expires_at=now()+interval '90 seconds' where id=j.review_id and state='running'; end if;
  insert into public.ai_usage(workspace_id,job_id,actor_id,attempt) values(j.workspace_id,j.id,j.actor_id,j.attempts);
  select * into v from public.request_revisions where request_id=j.request_id and number=j.revision;
  return jsonb_build_object('id',j.id,'kind',j.kind,'fields',v.fields-'references','leaseToken',j.lease_token,'attempts',j.attempts);
end; $$;
create function public.automation_finish(p_job uuid,p_lease uuid,p_output jsonb,p_error text,p_model text,p_retry boolean default false,p_usage jsonb default '{}') returns void language plpgsql security definer set search_path='' as $$
declare j public.automation_jobs; r public.requests; v public.request_revisions; item jsonb; src text; field text;
begin
  select * into j from public.automation_jobs where id=p_job;
  select * into r from public.requests where id=j.request_id for update;
  perform 1 from public.workspaces where id=j.workspace_id for update;
  select * into j from public.automation_jobs where id=p_job for update;
  if j.id is null or j.state<>'working' or j.lease_token is distinct from p_lease then raise exception 'INVALID_LEASE|This task lease is no longer available.'; end if;
  if j.lease_until<now() then p_error:='The task timed out.'; p_retry:=true; end if;
  if not public.automation_actor_allowed(j) then
    update public.automation_jobs set state=case when r.current_revision<>j.revision and j.kind<>'qa' then 'outdated' else 'cancelled' end,error='Source, access or automation policy changed.' where id=j.id;
    if j.kind='review' and exists(select 1 from public.review_runs where id=j.review_id and state='running') then perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),null,'AI review was cancelled. Review again.',p_model); end if;
    return;
  end if;
  if p_error is null and j.kind<>'review' then
    if p_output is null or octet_length(p_output::text)>20000 then raise exception 'INVALID_AI_OUTPUT|The assistance output is invalid.'; end if;
    select * into v from public.request_revisions where request_id=j.request_id and number=j.revision;
    if j.kind='qa' then
      if jsonb_typeof(p_output->'tests') is distinct from 'array' or jsonb_array_length(p_output->'tests') not between 1 and 20 then raise exception 'INVALID_AI_OUTPUT|Invalid QA draft.'; end if;
      for item in select value from jsonb_array_elements(p_output->'tests') loop
        src:=v.fields->'criteria'->>((item->>'criterionIndex')::integer);
        if src is null or coalesce(item->>'criterionQuote','')='' or position(item->>'criterionQuote' in src)=0 then raise exception 'INVALID_AI_OUTPUT|A QA draft cites a different source.'; end if;
      end loop;
    else
      field:=case j.kind when 'edits' then 'edits' else 'items' end;
      if jsonb_typeof(p_output->field) is distinct from 'array' or jsonb_array_length(p_output->field)>6 then raise exception 'INVALID_AI_OUTPUT|Invalid assistance output.'; end if;
      for item in select value from jsonb_array_elements(p_output->field) loop
        if item->>'evidenceField' not in ('title','problem','audience','behavior','scope','exclusions','criteria','edgeCases','dependencies','dataImpact','successMeasure','rationale') then raise exception 'INVALID_AI_OUTPUT|Invalid evidence field.'; end if;
        src:=case when item->>'evidenceField'='criteria' then (select string_agg(value,E'\n') from jsonb_array_elements_text(v.fields->'criteria')) else v.fields->>(item->>'evidenceField') end;
        if coalesce(item->>'evidenceQuote','')='' or position(item->>'evidenceQuote' in coalesce(src,''))=0 then raise exception 'INVALID_AI_OUTPUT|A suggestion cites a different source.'; end if;
      end loop;
    end if;
  end if;
  update public.ai_usage set model=p_model,input_tokens=case when p_usage->>'inputTokens' ~ '^\d{1,8}$' then (p_usage->>'inputTokens')::integer end,
    output_tokens=case when p_usage->>'outputTokens' ~ '^\d{1,8}$' then (p_usage->>'outputTokens')::integer end where job_id=j.id and attempt=j.attempts;
  if p_error is not null and p_retry and j.attempts<3 and j.kind<>'review' then
    update public.automation_jobs set state='queued',next_attempt=now()+interval '30 seconds'*j.attempts,error=left(p_error,500),model=p_model where id=j.id;
    return;
  end if;
  if j.kind='review' then
    perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),p_output,p_error,p_model);
    select error into p_error from public.review_runs where id=j.review_id;
  end if;
  update public.automation_jobs set state=case when p_error is null then 'ready' else 'failed' end,output=case when j.kind<>'review' and p_error is null then p_output end,error=left(p_error,500),model=p_model where id=j.id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(j.workspace_id,j.request_id,j.actor_id,'ai_'||j.kind||case when p_error is null then '_ready' else '_failed' end,j.revision);
end; $$;

create function public.automation_accept_edit(p_job uuid,p_index integer,p_expected integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); j public.automation_jobs; r public.requests; v public.request_revisions; item jsonb; f jsonb; d jsonb; result jsonb; field text;
begin
  select * into j from public.automation_jobs where id=p_job and workspace_id=w;
  select * into r from public.requests where id=j.request_id for update;
  if r.id is null or auth.uid()<>r.author_id then raise exception 'FORBIDDEN|Only the author can accept a requirement edit.'; end if;
  perform public.assert_revision(r,p_expected);
  select * into j from public.automation_jobs where id=p_job for update;
  select * into v from public.request_revisions where request_id=r.id and number=r.current_revision;
  if j.kind<>'edits' or j.state<>'ready' or j.revision<>v.number or j.input_hash<>v.input_hash or p_index<0 then raise exception 'OUTDATED|Generate suggestions for the current revision.'; end if;
  item:=j.output->'edits'->p_index; field:=item->>'field';
  if item is null or field is null or field not in ('title','problem','audience','behavior','scope','exclusions','criteria','edgeCases','dependencies','dataImpact','successMeasure','rationale') then raise exception 'INVALID_INPUT|Choose a valid suggested field edit.'; end if;
  f:=jsonb_set(v.fields,array[field],case when field='criteria' then to_jsonb(string_to_array(item->>'text',E'\n')) else to_jsonb(item->>'text') end);
  d:=jsonb_build_object('fields',f,'productReviewerId',coalesce(v.product_reviewer_id::text,''),'engineeringReviewerId',coalesce(v.engineering_reviewer_id::text,''),'checklistVersion',v.checklist_id,'fileIds',coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(v.files) x),'[]'));
  result:=public.handoff_command(r.id,jsonb_build_object('action','save','expectedRevision',p_expected,'draft',d),'ai-edit:'||j.id::text||':'||p_index);
  update public.automation_jobs set accepted=array_append(accepted,p_index) where id=j.id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(w,r.id,auth.uid(),'accepted_ai_edit',(result->>'currentRevision')::integer);
  return result;
end; $$;
create function public.automation_review_qa(p_job uuid) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); j public.automation_jobs; v public.request_revisions;
begin
  select * into j from public.automation_jobs where id=p_job and workspace_id=w for update;
  select * into v from public.request_revisions where request_id=j.request_id and number=j.revision;
  if j.id is null or j.kind<>'qa' or j.state<>'ready' then raise exception 'NOT_READY|Choose a completed QA draft.'; end if;
  if not exists(select 1 from public.memberships where workspace_id=w and user_id=auth.uid() and role='engineering_lead' and status='active' and user_id=v.engineering_reviewer_id) then raise exception 'FORBIDDEN|Only the assigned engineering lead can mark this QA draft reviewed.'; end if;
  update public.automation_jobs set reviewed_by=auth.uid() where id=j.id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(w,j.request_id,auth.uid(),'qa_draft_reviewed',j.revision);
end; $$;
create function public.automation_notifications() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'requestId',n.request_id,'title',n.title,'createdAt',n.created_at,'read',n.read_at is not null) order by n.created_at desc)
    from (select * from public.in_app_notifications where workspace_id=w and recipient_id=auth.uid() order by created_at desc limit 30) n),'[]');
end; $$;
create function public.automation_read_notification(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  update public.in_app_notifications set read_at=now() where id=p_id and workspace_id=w and recipient_id=auth.uid();
  if not found then raise exception 'NOT_FOUND|This notification could not be found.'; end if;
end; $$;
create function public.automation_remind(p_workspace uuid) returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  insert into public.in_app_notifications(workspace_id,recipient_id,request_id,revision,title)
  select r.workspace_id,m.user_id,r.id,r.current_revision,'Review waiting: '||left(v.fields->>'title',120)
    from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    join public.automation_policies p on p.workspace_id=r.workspace_id
    join public.memberships m on m.workspace_id=r.workspace_id and m.status='active'
      and ((m.role='product_lead' and m.user_id=v.product_reviewer_id) or (m.role='engineering_lead' and m.user_id=v.engineering_reviewer_id))
    where r.workspace_id=p_workspace and p.reminders and not r.archived and r.status in ('ready_for_approval','partially_approved')
      and r.updated_at<=now()-interval '1 hour'*p.reminder_hours
      and not exists(select 1 from public.approvals a where a.review_id=r.current_review_id and a.member_id=m.user_id)
    on conflict do nothing;
  get diagnostics n=row_count;
  delete from public.automation_nonces where created_at<now()-interval '10 minutes';
  delete from public.automation_jobs j using public.workspaces w where j.workspace_id=w.id and w.id=p_workspace
    and j.created_at<now()-interval '1 day'*w.retention_days and j.state in ('ready','failed','outdated','cancelled') and cardinality(j.accepted)=0 and j.reviewed_by is null;
  return n;
end; $$;
create function public.automation_nonce(p_nonce uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  insert into public.automation_nonces(nonce) values(p_nonce);
exception when unique_violation then raise exception 'REPLAY|This internal request was already processed.';
end; $$;

revoke execute on function public.automation_policy(),public.automation_set_policy(jsonb),public.automation_job_json(public.automation_jobs),public.automation_tasks(uuid),public.automation_request(uuid,text,integer,uuid),public.handoff_command(uuid,jsonb,text),public.handoff_start_review(uuid,integer,text),public.automation_actor_allowed(public.automation_jobs),public.automation_claim(uuid,uuid),public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb),public.automation_accept_edit(uuid,integer,integer),public.automation_review_qa(uuid),public.automation_notifications(),public.automation_read_notification(uuid),public.automation_remind(uuid),public.automation_nonce(uuid) from public,anon,authenticated;
grant execute on function public.automation_policy(),public.automation_set_policy(jsonb),public.automation_tasks(uuid),public.automation_request(uuid,text,integer,uuid),public.handoff_command(uuid,jsonb,text),public.handoff_start_review(uuid,integer,text),public.automation_accept_edit(uuid,integer,integer),public.automation_review_qa(uuid),public.automation_notifications(),public.automation_read_notification(uuid) to authenticated;
grant execute on function public.automation_claim(uuid,uuid),public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb),public.automation_remind(uuid),public.automation_nonce(uuid) to service_role;

create function public.automation_reserve_probe() returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p public.automation_policies;
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  select * into p from public.automation_policies where workspace_id=w;
  if (select count(*) from public.ai_usage where workspace_id=w and created_at>=(date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'))>=coalesce(p.daily_limit,50)
    or exists(select 1 from public.ai_usage where workspace_id=w and actor_id=auth.uid() and job_id is null and created_at>now()-interval '1 hour') then raise exception 'RATE_LIMIT|Provider checks are limited to one per hour and the workspace daily budget.'; end if;
  insert into public.ai_usage(workspace_id,actor_id,attempt) values(w,auth.uid(),1);
end; $$;
revoke execute on function public.automation_reserve_probe() from public,anon,authenticated;
grant execute on function public.automation_reserve_probe() to authenticated;
