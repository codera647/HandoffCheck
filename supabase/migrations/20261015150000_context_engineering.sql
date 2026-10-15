begin;

-- Reuse existing private receipts. No new transcript, user profile or shared memory store.
alter function public.intake_claim(uuid,jsonb) rename to intake_claim_context_core;
create function public.intake_claim(p_key uuid,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; prefix jsonb; memory jsonb; n integer; t public.intake_turns;
begin
  result:=public.intake_claim_context_core(p_key,p_input);
  if not (result->>'created')::boolean then return result; end if;
  select * into t from public.intake_turns where id=(result->>'id')::uuid;
  n:=jsonb_array_length(p_input->'messages');
  if n>=3 and p_input->'messages'->(n-2)->>'role'='assistant' then
    select jsonb_build_object('messages',jsonb_agg(value order by ordinal)) into prefix
      from jsonb_array_elements(p_input->'messages') with ordinality a(value,ordinal) where ordinal<=n-2;
    select response into memory from public.intake_turns
      where workspace_id=t.workspace_id and actor_id=t.actor_id and state='ready'
        and policy_version=t.policy_version and created_at>now()-interval '1 day'
        and input_hash=public.json_hash(prefix)
      order by created_at desc,id limit 1;
  end if;
  return result||jsonb_build_object('memory',memory);
end; $$;
revoke execute on function public.intake_claim_context_core(uuid,jsonb),public.intake_claim(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.intake_claim(uuid,jsonb) to authenticated;

alter table public.ai_usage add column context_manifest jsonb;

-- Store only whitelisted counters and application guidance IDs. Never persist source in telemetry.
create function public.ai_context_manifest(p_value jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare ids jsonb;
begin
  if p_value->>'version' is distinct from 'handoff-context-v1'
    or coalesce(p_value->>'task','') not in ('intake','review','edits','summary','qa')
    or coalesce(p_value->>'requestBytes','') !~ '^\d{1,6}$'
    or coalesce(p_value->>'sourceBytes','') !~ '^\d{1,6}$'
    or coalesce(p_value->>'omittedAssistantMessages','') !~ '^\d{1,2}$'
    or jsonb_typeof(p_value->'memoryUsed') is distinct from 'boolean'
    or jsonb_typeof(p_value->'guidanceIds') is distinct from 'array'
    then return null; end if;
  select jsonb_agg(value order by ordinal) into ids
    from jsonb_array_elements_text(p_value->'guidanceIds') with ordinality a(value,ordinal)
    where ordinal<=3 and value in ('scope-v1','acceptance-v1','permissions-v1','boundaries-v1','drafting-v1','review-v1','qa-v1','editing-v1');
  return jsonb_build_object('version','handoff-context-v1','task',p_value->>'task',
    'requestBytes',(p_value->>'requestBytes')::integer,'sourceBytes',(p_value->>'sourceBytes')::integer,
    'omittedAssistantMessages',(p_value->>'omittedAssistantMessages')::integer,
    'memoryUsed',(p_value->>'memoryUsed')::boolean,'guidanceIds',coalesce(ids,'[]'));
end; $$;
revoke execute on function public.ai_context_manifest(jsonb) from public,anon,authenticated,service_role;

-- Existing finalizers remain authoritative for leases, access, policy and revision checks.
alter function public.intake_finish(uuid,uuid,uuid,jsonb,text,text,jsonb) rename to intake_finish_context_core;
create function public.intake_finish(p_id uuid,p_actor uuid,p_lease uuid,p_response jsonb,p_error text,p_model text,p_usage jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result:=public.intake_finish_context_core(p_id,p_actor,p_lease,p_response,p_error,p_model,p_usage);
  update public.ai_usage set context_manifest=public.ai_context_manifest(p_usage->'context')
    where id=(select usage_id from public.intake_turns where id=p_id);
  return result;
end; $$;
alter function public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb) rename to automation_finish_context_core;
create function public.automation_finish(p_job uuid,p_lease uuid,p_output jsonb,p_error text,p_model text,p_retry boolean default false,p_usage jsonb default '{}') returns void
language plpgsql security definer set search_path='' as $$
begin
  perform public.automation_finish_context_core(p_job,p_lease,p_output,p_error,p_model,p_retry,p_usage);
  update public.ai_usage set context_manifest=public.ai_context_manifest(p_usage->'context')
    where job_id=p_job and attempt=(select attempts from public.automation_jobs where id=p_job);
  if p_usage->'context'->>'version'='handoff-context-v1' then
    update public.review_runs set prompt_version='handoff-context-v1'
      where id=(select review_id from public.automation_jobs where id=p_job and kind='review');
  end if;
end; $$;
revoke execute on function public.intake_finish_context_core(uuid,uuid,uuid,jsonb,text,text,jsonb),public.intake_finish(uuid,uuid,uuid,jsonb,text,text,jsonb),public.automation_finish_context_core(uuid,uuid,jsonb,text,text,boolean,jsonb),public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.intake_finish(uuid,uuid,uuid,jsonb,text,text,jsonb),public.automation_finish(uuid,uuid,jsonb,text,text,boolean,jsonb) to service_role;
commit;
