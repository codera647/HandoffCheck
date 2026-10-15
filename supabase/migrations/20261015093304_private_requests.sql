begin;

-- The same participant rule protects RPCs, direct table reads and file access.
create function public.can_access_request_as(p_request uuid,p_actor uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.requests r
    join public.memberships m on m.workspace_id=r.workspace_id and m.user_id=p_actor and m.status='active'
    left join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    where r.id=p_request and (r.author_id=p_actor or r.status<>'draft' and (
      m.role='product_lead' and v.product_reviewer_id=p_actor or
      m.role='engineering_lead' and v.engineering_reviewer_id=p_actor))
  );
$$;
create function public.can_access_request(p_request uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select public.can_access_request_as(p_request,auth.uid());
$$;
create function public.assert_request_access(p_request uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_access_request(p_request) then
    raise exception 'NOT_FOUND|This request could not be found.';
  end if;
end; $$;
revoke execute on function public.can_access_request_as(uuid,uuid),public.can_access_request(uuid),public.assert_request_access(uuid) from public,anon,authenticated;
grant execute on function public.can_access_request(uuid) to authenticated;

drop policy workspace_read on public.requests;
create policy participant_read on public.requests for select to authenticated using(public.can_access_request(id));
do $$ declare t text; begin
  foreach t in array array['request_revisions','review_runs','approvals','briefs','comments','stored_files'] loop
    execute format('drop policy workspace_read on public.%I',t);
    execute format('create policy participant_read on public.%I for select to authenticated using(public.can_access_request(request_id))',t);
  end loop;
end; $$;
drop policy workspace_read on public.findings;
create policy participant_read on public.findings for select to authenticated using(
  exists(select 1 from public.review_runs x where x.id=review_id and public.can_access_request(x.request_id)));
drop policy workspace_read on public.finding_resolutions;
create policy participant_read on public.finding_resolutions for select to authenticated using(
  exists(select 1 from public.findings f join public.review_runs x on x.id=f.review_id where f.id=finding_id and public.can_access_request(x.request_id)));
drop policy workspace_read on public.audit_events;
create policy participant_read on public.audit_events for select to authenticated using(
  case when request_id is null then public.is_admin(workspace_id) else public.can_access_request(request_id) end);
drop policy document_read on public.workspace_documents;
create policy document_read on public.workspace_documents for select to authenticated using(
  exists(select 1 from public.briefs b where b.id=brief_id and public.can_access_request(b.request_id)));
drop policy notification_read on public.in_app_notifications;
create policy notification_read on public.in_app_notifications for select to authenticated using(
  recipient_id=auth.uid() and public.can_access_request(request_id));
create or replace function public.can_read_object(p_path text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.stored_files where path=p_path and state='verified' and public.can_access_request(request_id));
$$;

-- Preserve canonical write rules; narrow their public entry points.
alter function public.handoff_get(uuid) rename to handoff_get_access_core;
create function public.handoff_get(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.assert_request_access(p_id);
  return public.handoff_get_access_core(p_id);
end; $$;
alter function public.handoff_command(uuid,jsonb,text) rename to handoff_command_access_core;
create function public.handoff_command(p_id uuid,p_command jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=p_id for update;
  perform public.assert_request_access(p_id);
  return public.handoff_command_access_core(p_id,p_command,p_key);
end; $$;
alter function public.handoff_start_review(uuid,integer,text) rename to handoff_start_review_access_core;
create function public.handoff_start_review(p_id uuid,p_expected integer,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=p_id for update;
  perform public.assert_request_access(p_id);
  return public.handoff_start_review_access_core(p_id,p_expected,p_key);
end; $$;
alter function public.handoff_reserve_file(uuid,text,text,bigint) rename to handoff_reserve_file_access_core;
create function public.handoff_reserve_file(p_request uuid,p_name text,p_type text,p_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=p_request for update;
  perform public.assert_request_access(p_request);
  return public.handoff_reserve_file_access_core(p_request,p_name,p_type,p_size);
end; $$;
alter function public.automation_tasks(uuid) rename to automation_tasks_access_core;
create function public.automation_tasks(p_request uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.assert_request_access(p_request);
  return public.automation_tasks_access_core(p_request);
end; $$;
alter function public.automation_request(uuid,text,integer,uuid) rename to automation_request_access_core;
create function public.automation_request(p_request uuid,p_kind text,p_expected integer,p_brief uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=p_request for update;
  perform public.assert_request_access(p_request);
  return public.automation_request_access_core(p_request,p_kind,p_expected,p_brief);
end; $$;
alter function public.automation_review_qa(uuid) rename to automation_review_qa_access_core;
create function public.automation_review_qa(p_job uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=(select request_id from public.automation_jobs where id=p_job) for update;
  perform public.assert_request_access((select request_id from public.automation_jobs where id=p_job));
  perform public.automation_review_qa_access_core(p_job);
end; $$;
alter function public.automation_accept_edit(uuid,integer,integer) rename to automation_accept_edit_access_core;
create function public.automation_accept_edit(p_job uuid,p_index integer,p_expected integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.requests where id=(select request_id from public.automation_jobs where id=p_job) for update;
  perform public.assert_request_access((select request_id from public.automation_jobs where id=p_job));
  return public.automation_accept_edit_access_core(p_job,p_index,p_expected);
end; $$;
alter function public.handoff_google_document(uuid) rename to handoff_google_document_access_core;
create function public.handoff_google_document(p_brief uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.assert_request_access((select request_id from public.briefs where id=p_brief));
  return public.handoff_google_document_access_core(p_brief);
end; $$;
alter function public.linear_preview_for(uuid,uuid) rename to linear_preview_for_access_core;
create function public.linear_preview_for(p_actor uuid,p_brief uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_access_request_as((select request_id from public.briefs where id=p_brief),p_actor) then
    raise exception 'NOT_FOUND|This approved brief could not be found.';
  end if;
  return public.linear_preview_for_access_core(p_actor,p_brief);
end; $$;
alter function public.linear_assert_source(uuid,uuid) rename to linear_assert_source_access_core;
create function public.linear_assert_source(p_actor uuid,p_brief uuid) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not public.can_access_request_as((select request_id from public.briefs where id=p_brief),p_actor) then
    raise exception 'NOT_FOUND|This approved brief could not be found.';
  end if;
  perform public.linear_assert_source_access_core(p_actor,p_brief);
end; $$;
alter function public.automation_actor_allowed(public.automation_jobs) rename to automation_actor_allowed_access_core;
create function public.automation_actor_allowed(j public.automation_jobs) returns boolean language sql stable set search_path='' as $$
  select public.can_access_request_as(j.request_id,j.actor_id) and public.automation_actor_allowed_access_core(j);
$$;

create or replace function public.handoff_list(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p integer:=greatest(1,least(10000,coalesce((p_filters->>'page')::integer,1))); result jsonb; n integer;
begin
  with filtered as (
    select r.* from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    where r.workspace_id=w and public.can_access_request(r.id)
    and (case when coalesce(p_filters->>'assigned','')='' then r.author_id=auth.uid()
      else p_filters->>'assigned'=auth.uid()::text and (v.product_reviewer_id=auth.uid() or v.engineering_reviewer_id=auth.uid()) end)
    and r.archived=coalesce((p_filters->>'archived')::boolean,false)
    and (coalesce(p_filters->>'search','')='' or position(lower(p_filters->>'search') in lower(coalesce(v.fields->>'title','')||' HC-'||lpad(r.number::text,4,'0')))>0)
    and (coalesce(p_filters->>'status','')='' or r.status=p_filters->>'status')
    and (coalesce(p_filters->>'author','')='' or r.author_id::text=p_filters->>'author')
  ), paged as (select * from filtered order by updated_at desc,number desc limit 25 offset (p-1)*25)
  select (select count(*) from filtered),coalesce((select jsonb_agg(public.summary_json(x) order by x.updated_at desc,x.number desc) from paged x),'[]') into n,result;
  return jsonb_build_object('items',result,'total',n,'page',p,'pageSize',25);
end; $$;
create or replace function public.automation_notifications() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'requestId',n.request_id,'title',n.title,'createdAt',n.created_at,'read',n.read_at is not null) order by n.created_at desc)
    from (select * from public.in_app_notifications where workspace_id=w and recipient_id=auth.uid() and public.can_access_request(request_id) order by created_at desc limit 30) n),'[]');
end; $$;

revoke execute on function public.handoff_get_access_core(uuid),public.handoff_command_access_core(uuid,jsonb,text),public.handoff_start_review_access_core(uuid,integer,text),public.handoff_reserve_file_access_core(uuid,text,text,bigint),public.automation_tasks_access_core(uuid),public.automation_request_access_core(uuid,text,integer,uuid),public.automation_review_qa_access_core(uuid),public.handoff_google_document_access_core(uuid),public.linear_preview_for_access_core(uuid,uuid),public.linear_assert_source_access_core(uuid,uuid),public.automation_actor_allowed_access_core(public.automation_jobs) from public,anon,authenticated,service_role;
revoke execute on function public.handoff_get(uuid),public.handoff_command(uuid,jsonb,text),public.handoff_start_review(uuid,integer,text),public.handoff_reserve_file(uuid,text,text,bigint),public.automation_tasks(uuid),public.automation_request(uuid,text,integer,uuid),public.automation_review_qa(uuid),public.handoff_google_document(uuid),public.linear_preview_for(uuid,uuid),public.linear_assert_source(uuid,uuid),public.automation_actor_allowed(public.automation_jobs) from public,anon,authenticated;
grant execute on function public.handoff_get(uuid),public.handoff_command(uuid,jsonb,text),public.handoff_start_review(uuid,integer,text),public.handoff_reserve_file(uuid,text,text,bigint),public.automation_tasks(uuid),public.automation_request(uuid,text,integer,uuid),public.automation_review_qa(uuid),public.handoff_google_document(uuid) to authenticated;

-- App-created requests do not enter the Google operator's shared tracking/export surface.
-- Google Form submissions keep their established Google-owned intake pipeline.
alter function public.workspace_bridge(uuid,text,jsonb) rename to workspace_bridge_access_core;
create function public.workspace_bridge(p_workspace uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if p_action='document' and not exists(select 1 from public.briefs b join public.workspace_submissions s on s.request_id=b.request_id and s.workspace_id=b.workspace_id
    where b.id=(p_data->>'briefId')::uuid and b.workspace_id=p_workspace) then raise exception 'NOT_FOUND|This approved brief could not be found.'; end if;
  result:=public.workspace_bridge_access_core(p_workspace,p_action,p_data);
  if p_action='sync' then
    result:=jsonb_set(result,'{requests}',coalesce((select jsonb_agg(item) from jsonb_array_elements(result->'requests') item
      where exists(select 1 from public.workspace_submissions s where s.workspace_id=p_workspace and s.request_id=(item->>'id')::uuid)),'[]'));
    result:=jsonb_set(result,'{briefs}',coalesce((select jsonb_agg(item) from jsonb_array_elements(result->'briefs') item
      where exists(select 1 from public.workspace_submissions s where s.workspace_id=p_workspace and s.request_id=(item->>'requestId')::uuid)),'[]'));
  end if;
  return result;
end; $$;
revoke execute on function public.automation_accept_edit_access_core(uuid,integer,integer),public.automation_accept_edit(uuid,integer,integer),public.workspace_bridge_access_core(uuid,text,jsonb),public.workspace_bridge(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.automation_accept_edit(uuid,integer,integer) to authenticated;
grant execute on function public.workspace_bridge(uuid,text,jsonb) to service_role;

commit;
