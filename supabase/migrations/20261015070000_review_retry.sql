-- Retry temporary review failures through the existing budgeted queue, at most three attempts.
create or replace function public.automation_finish(p_job uuid,p_lease uuid,p_output jsonb,p_error text,p_model text,p_retry boolean default false,p_usage jsonb default '{}') returns void language plpgsql security definer set search_path='' as $$
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
  if p_error is not null and p_retry and j.attempts<3 then
    update public.automation_jobs set state='queued',next_attempt=now()+interval '30 seconds'*j.attempts,error=left(p_error,500),model=p_model where id=j.id;
    if j.kind='review' then
      update public.review_runs set expires_at=now()+interval '30 seconds'*j.attempts+interval '90 seconds' where id=j.review_id and state='running';
    end if;
    return;
  end if;
  if j.kind='review' then
    perform public.handoff_finish_review(j.review_id,(select lease_token from public.review_runs where id=j.review_id),p_output,p_error,p_model);
    select error into p_error from public.review_runs where id=j.review_id;
  end if;
  update public.automation_jobs set state=case when p_error is null then 'ready' else 'failed' end,output=case when j.kind<>'review' and p_error is null then p_output end,error=left(p_error,500),model=p_model where id=j.id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(j.workspace_id,j.request_id,j.actor_id,'ai_'||j.kind||case when p_error is null then '_ready' else '_failed' end,j.revision);
end; $$;

revoke all on function public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb) to service_role;
