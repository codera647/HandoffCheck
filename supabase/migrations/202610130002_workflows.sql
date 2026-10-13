begin;

-- Escape authored text so exports remain literal Markdown.
create function public.md(p text) returns text language plpgsql immutable set search_path='' as $$
declare result text:=coalesce(p,''); k text;
begin
  foreach k in array array[chr(92),'`','*','_','{','}','[',']','<','>','#','!','|'] loop result:=replace(result,k,chr(92)||k); end loop;
  return result;
end;
$$;
create function public.brief_markdown(r public.requests,v public.request_revisions) returns text language plpgsql stable set search_path='' as $$
declare f jsonb:=v.fields; output text; k text; pair text[]; item jsonb; a record;
begin
  output:='# '||public.md(f->>'title')||E'\n\nHC-'||lpad(r.number::text,4,'0')||' · Revision '||v.number||E'\n\n';
  foreach pair slice 1 in array array[['Problem and evidence','problem'],['Target users','audience'],['Success measure','successMeasure'],['In scope','scope'],['Out of scope','exclusions'],['Expected behavior','behavior'],['Edge cases','edgeCases'],['Data and permissions','dataImpact'],['Dependencies and constraints','dependencies']] loop
    output:=output||'## '||pair[1]||E'\n\n'||public.md(f->>pair[2])||E'\n\n';
  end loop;
  output:=output||E'## Priority\n\n'||public.md((f->>'priority')||': '||(f->>'rationale'))||E'\n\n## Target delivery\n\n'||case when (f->>'unscheduled')::boolean then 'Not scheduled' else public.md((f->>'targetDate')||' ('||(f->>'timezone')||')') end||E'\n\n## Acceptance criteria\n\n';
  for k in select jsonb_array_elements_text(f->'criteria') loop output:=output||'- '||public.md(k)||E'\n'; end loop;
  output:=output||E'\n## References\n\n';
  for item in select value from jsonb_array_elements(f->'references') loop output:=output||'- '||public.md(item->>'label')||': '||public.md(item->>'url')||E'\n'; end loop;
  for item in select value from jsonb_array_elements(v.files) loop output:=output||'- '||public.md(item->>'name')||' — attachment ID '||(item->>'id')||E' (open the source request to download)\n'; end loop;
  output:=output||E'\n## Review decisions\n\n';
  for a in select x.stage,m.name,x.created_at from public.approvals x join public.memberships m on m.workspace_id=x.workspace_id and m.user_id=x.member_id where x.review_id=r.current_review_id order by x.stage loop
    output:=output||'- '||initcap(a.stage)||': '||public.md(a.name)||' · '||a.created_at::text||E'\n';
  end loop;
  output:=output||E'\nReview mode: '||(select case when mode='ai' then 'AI language review and checklist' else 'Checklist only; language ambiguity was not reviewed by AI' end from public.review_runs where id=r.current_review_id)||E'.\n\n## Implementation checklist\n\n';
  for k in select jsonb_array_elements_text(f->'criteria') loop output:=output||'- [ ] '||public.md(k)||E'\n'; end loop;
  return output||E'\nInput SHA-256: `'||v.input_hash||E'`\nChecklist: '||v.checklist_id::text||E'\n';
end; $$;

create function public.handoff_start_review(p_id uuid,p_expected integer,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.requests; v public.request_revisions; w public.workspaces; c public.checklist_versions; x public.command_receipts; run public.review_runs; k text; missing boolean; payload jsonb:=jsonb_build_object('expectedRevision',p_expected);
begin
  select * into r from public.requests where id=p_id and public.is_member(workspace_id) for update;
  if r.id is null then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  x:=public.receipt(r.workspace_id,p_id::text||':review',p_key,payload);
  if x.key is not null then return jsonb_build_object('record',public.handoff_get(r.id),'claimed',false); end if;
  perform public.assert_revision(r,p_expected);
  select * into v from public.request_revisions where request_id=r.id and number=r.current_revision;
  if r.archived then raise exception 'ARCHIVED|Restore the request first.'; end if;
  if auth.uid()<>r.author_id and not public.is_assigned(r,v) then raise exception 'FORBIDDEN|Only the author or assigned leads can review.'; end if;
  perform public.assert_reviewers(r,v);
  if r.current_revision<r.minimum_approval_revision then raise exception 'REVISION_REQUIRED|Save a new revision to address the requested changes.'; end if;
  if exists(select 1 from public.briefs where request_id=r.id and revision=v.number) then raise exception 'BRIEF_EXISTS|Create a new revision before another review.'; end if;
  -- Workspace lock serializes the daily/concurrency budget across different requests.
  select * into w from public.workspaces where id=r.workspace_id for update;
  perform public.assert_revision(r,p_expected);
  perform public.assert_reviewers(r,v);
  update public.review_runs set state='error',error='The review timed out. Try again.' where workspace_id=w.id and state='running' and expires_at<=now();
  if exists(select 1 from public.review_runs where request_id=r.id and state='running') then raise exception 'REVIEW_RUNNING|A review is already running.'; end if;
  if (select count(*) from public.review_runs where workspace_id=w.id and actor_id=auth.uid() and created_at>now()-interval '1 hour')>=10 or (select count(*) from public.review_runs where workspace_id=w.id and created_at>date_trunc('day',now()))>=50 or (select count(*) from public.review_runs where workspace_id=w.id and state='running')>=2 then raise exception 'RATE_LIMIT|The review limit has been reached. Try later.'; end if;
  insert into public.review_runs(workspace_id,request_id,revision,input_hash,mode,actor_id) values(w.id,r.id,v.number,v.input_hash,w.review_mode,auth.uid()) returning * into run;
  select * into c from public.checklist_versions where id=v.checklist_id;
  for k in select jsonb_array_elements_text(c.required_fields) loop
    missing:=case when k='criteria' then jsonb_array_length(v.fields->k)=0 or exists(select 1 from jsonb_array_elements_text(v.fields->k) t(value) where btrim(value)='') else btrim(coalesce(v.fields->>k,''))='' end;
    if missing then insert into public.findings(workspace_id,review_id,body) values(w.id,run.id,jsonb_build_object('kind','missing_detail','field',k,'severity','blocking','origin','deterministic','evidence','','question','What should be recorded for '||k||'?','explanation','This field is required by the checklist for this revision.')); end if;
  end loop;
  if w.review_mode='checklist_only' then update public.review_runs set state='succeeded' where id=run.id; end if;
  update public.requests set current_review_id=run.id,status=case when w.review_mode='ai' then 'reviewing' when exists(select 1 from public.findings where review_id=run.id) then 'needs_clarification' else 'ready_for_approval' end,updated_at=now() where id=r.id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(w.id,r.id,auth.uid(),'review',v.number);
  insert into public.command_receipts(workspace_id,actor_id,key,operation,payload_hash,request_id) values(w.id,auth.uid(),p_key,p_id::text||':review',public.json_hash(payload),r.id);
  return jsonb_build_object('record',public.handoff_get(r.id),'claimed',w.review_mode='ai','runId',run.id,'leaseToken',run.lease_token,'revision',public.revision_json(v));
end; $$;

-- Only the server holding the lease can complete a provider review.
create function public.handoff_finish_review(p_run uuid,p_token uuid,p_output jsonb,p_error text,p_model text) returns void language plpgsql security definer set search_path='' as $$
declare run public.review_runs; r public.requests; v public.request_revisions; item jsonb; finding_body jsonb; evidence text; field text; source text; invalid boolean:=false;
begin
  -- Always lock request before review to match interactive commands.
  select request_id into r.id from public.review_runs where id=p_run;
  select * into r from public.requests where id=r.id for update;
  select * into run from public.review_runs where id=p_run for update;
  if run.id is null or run.lease_token<>p_token or run.state<>'running' then raise exception 'INVALID_LEASE|This review lease is no longer available.'; end if;
  if run.expires_at<=now() then p_error:='The review timed out. Try again.'; end if;
  select * into v from public.request_revisions where request_id=r.id and number=run.revision;
  if p_error is null then
    invalid:=p_output is null or octet_length(p_output::text)>20000 or p_output->>'schema_version' is distinct from '1' or jsonb_typeof(p_output->'findings') is distinct from 'array' or jsonb_typeof(p_output->'potential_misunderstandings') is distinct from 'array' or jsonb_typeof(p_output->'unknowns') is distinct from 'array';
    if not invalid then invalid:=jsonb_array_length(p_output->'findings')>10 or jsonb_array_length(p_output->'potential_misunderstandings')>3 or jsonb_array_length(p_output->'unknowns')>10; end if;
    if not invalid then
      for item in select value from jsonb_array_elements((p_output->'findings')||(p_output->'potential_misunderstandings')) loop
        field:=item->>'field'; evidence:=item->>'evidence_quote';
        source:=case when field='criteria' then (select string_agg(value,E'\n') from jsonb_array_elements_text(v.fields->'criteria')) else v.fields->>field end;
        if field is null or field not in ('title','problem','audience','behavior','scope','exclusions','criteria','edgeCases','dependencies','dataImpact','successMeasure','rationale') or item->>'kind' is null or item->>'kind' not in ('missing_detail','ambiguity','conflict','risk') or item->>'severity' is null or item->>'severity' not in ('blocking','advisory') or evidence is null or length(evidence)>1500 or (evidence='' and item->>'kind'<>'missing_detail') or (evidence<>'' and position(evidence in coalesce(source,''))=0) or length(coalesce(item->>'question','')) not between 1 and 1000 or length(coalesce(item->>'explanation','')) not between 1 and 1500 then invalid:=true; exit; end if;
      end loop;
      if exists(select 1 from jsonb_array_elements(p_output->'unknowns') t(value) where jsonb_typeof(value)<>'string' or length(value#>>'{}')>250) then invalid:=true; end if;
    end if;
    if invalid then p_error:='The language review returned an invalid response. Try again.'; end if;
  end if;
  if p_error is null then
    for item in select value from jsonb_array_elements((p_output->'findings')||(p_output->'potential_misunderstandings')) loop
      finding_body:=jsonb_build_object('kind',item->>'kind','field',item->>'field','severity',item->>'severity','origin','ai','evidence',item->>'evidence_quote','question',item->>'question','explanation',item->>'explanation');
      insert into public.findings(workspace_id,review_id,body) values(run.workspace_id,run.id,finding_body);
    end loop;
  end if;
  update public.review_runs set state=case when r.current_review_id is distinct from run.id or r.current_revision<>run.revision or r.archived then 'superseded' when p_error is not null then 'error' else 'succeeded' end,error=left(p_error,500),unknowns=case when p_error is null then p_output->'unknowns' else '[]'::jsonb end,model_id=p_model where id=run.id;
  if r.current_review_id=run.id and r.current_revision=run.revision and not r.archived then
    update public.requests set status=case when p_error is not null then 'review_error' when exists(select 1 from public.findings where review_id=run.id and body->>'severity'='blocking') then 'needs_clarification' else 'ready_for_approval' end,updated_at=now() where id=r.id;
  end if;
end; $$;

create function public.handoff_accept_membership() returns void language plpgsql security definer set search_path='' as $$
declare email_value text; display_name text; invitation public.invitations;
begin
  if auth.uid() is null then raise exception 'ACCESS_DENIED|Sign in to accept an invitation.'; end if;
  if exists(select 1 from public.memberships where user_id=auth.uid() and status='active') then return; end if;
  select lower(btrim(email)),left(coalesce(nullif(raw_user_meta_data->>'full_name',''),split_part(email,'@',1)),100) into email_value,display_name from auth.users where id=auth.uid() and email_confirmed_at is not null;
  select * into invitation from public.invitations where email=email_value and consumed_by is null and expires_at>now() order by created_at limit 1 for update;
  if invitation.id is null then raise exception 'ACCESS_DENIED|Ask your administrator for an invitation to this workspace.'; end if;
  insert into public.memberships(workspace_id,user_id,name,role,status) values(invitation.workspace_id,auth.uid(),display_name,invitation.role,'active') on conflict(workspace_id,user_id) do update set role=excluded.role,status='active';
  update public.invitations set consumed_by=auth.uid() where id=invitation.id;
  insert into public.audit_events(workspace_id,actor_id,action) values(invitation.workspace_id,auth.uid(),'membership_accepted');
end; $$;
create function public.handoff_invite(p_email text,p_role text) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); e text:=lower(btrim(p_email));
begin
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Only administrators can invite employees.'; end if;
  if e is null or length(e)>254 or e!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_role is null or p_role not in ('member','product_lead','engineering_lead','admin') then raise exception 'INVALID_INPUT|Enter an email address and role.'; end if;
  perform 1 from public.workspaces where id=w for update;
  delete from public.invitations where workspace_id=w and email=e and consumed_by is null and expires_at<=now();
  insert into public.invitations(workspace_id,email,role,invited_by) values(w,e,p_role,auth.uid());
  insert into public.audit_events(workspace_id,actor_id,action) values(w,auth.uid(),'invitation_created');
end; $$;
create function public.handoff_change_member(p_user uuid,p_role text,p_status text) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); m public.memberships;
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Only administrators can change access.'; end if;
  if p_role is null or p_role not in ('member','product_lead','engineering_lead','admin') or p_status is null or p_status not in ('active','revoked') then raise exception 'INVALID_INPUT|Choose a valid role and status.'; end if;
  select * into m from public.memberships where workspace_id=w and user_id=p_user;
  if m.user_id is null then raise exception 'NOT_FOUND|This member could not be found.'; end if;
  if m.role='admin' and m.status='active' and (p_role<>'admin' or p_status<>'active') and (select count(*) from public.memberships where workspace_id=w and role='admin' and status='active')<=1 then raise exception 'LAST_ADMIN|Keep at least one active administrator.'; end if;
  update public.memberships set role=p_role,status=p_status where workspace_id=w and user_id=p_user;
  insert into public.audit_events(workspace_id,actor_id,action) values(w,auth.uid(),'membership_changed');
end; $$;
create function public.handoff_publish_checklist(p_name text) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Only administrators can publish a checklist.'; end if;
  if length(btrim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'INVALID_INPUT|Name the checklist version.'; end if;
  insert into public.checklist_versions(workspace_id,name) values(w,btrim(p_name));
  insert into public.audit_events(workspace_id,actor_id,action) values(w,auth.uid(),'checklist_published');
end; $$;

create function public.handoff_reserve_file(p_request uuid,p_name text,p_type text,p_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.requests; f public.stored_files; file_id uuid:=gen_random_uuid();
begin
  select * into r from public.requests where id=p_request and public.is_member(workspace_id) for update;
  if r.id is null then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  if auth.uid()<>r.author_id or r.archived then raise exception 'FORBIDDEN|Only the author can upload to an active request.'; end if;
  if length(coalesce(p_name,'')) not between 1 and 250 or p_type is null or p_type not in ('image/png','image/jpeg','application/pdf') or p_size is null or p_size not between 1 and 5000000 then raise exception 'INVALID_FILE|Choose a PNG, JPEG, or PDF up to 5 MB.'; end if;
  perform 1 from public.workspaces where id=r.workspace_id for update;
  if not public.is_member(r.workspace_id) then raise exception 'ACCESS_DENIED|Your workspace access is unavailable.'; end if;
  if (select count(*) from public.stored_files where request_id=r.id)>=5 then raise exception 'FILE_LIMIT|This request already has five retained files.'; end if;
  if (select coalesce(sum(size),0) from public.stored_files where workspace_id=r.workspace_id)+p_size>700000000 then raise exception 'STORAGE_LIMIT|The workspace storage budget is full.'; end if;
  insert into public.stored_files(id,workspace_id,request_id,owner_id,name,type,size,path) values(file_id,r.workspace_id,r.id,auth.uid(),p_name,p_type,p_size,r.workspace_id::text||'/'||r.id::text||'/'||file_id::text) returning * into f;
  return jsonb_build_object('id',f.id,'path',f.path);
end; $$;
create function public.handoff_verify_file(p_file uuid,p_actor uuid,p_valid boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.stored_files; r public.requests;
begin
  select * into f from public.stored_files where id=p_file for update;
  select * into r from public.requests where id=f.request_id;
  if f.id is null or f.owner_id<>p_actor or r.author_id<>p_actor or r.archived or not exists(select 1 from public.memberships where workspace_id=f.workspace_id and user_id=p_actor and status='active') then raise exception 'FORBIDDEN|This upload is unavailable.'; end if;
  if f.state='verified' then return jsonb_build_object('id',f.id,'name',f.name,'type',f.type,'size',f.size); end if;
  if f.state<>'pending' or f.expires_at<=now() then raise exception 'UPLOAD_EXPIRED|Reserve a new upload.'; end if;
  update public.stored_files set state=case when p_valid then 'verified' else 'rejected' end where id=f.id;
  return jsonb_build_object('id',f.id,'name',f.name,'type',f.type,'size',f.size);
end; $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('request-files','request-files',false,5000000,array['image/png','image/jpeg','application/pdf']) on conflict(id) do nothing;
create function public.can_upload_object(p_path text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.stored_files f join public.requests r on r.id=f.request_id where f.path=p_path and f.owner_id=auth.uid() and r.author_id=auth.uid() and not r.archived and f.state='pending' and f.expires_at>now() and public.is_member(f.workspace_id));
$$;
create function public.can_read_object(p_path text) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.stored_files where path=p_path and state='verified' and public.is_member(workspace_id));
$$;
create policy reserved_upload on storage.objects for insert to authenticated with check(bucket_id='request-files' and public.can_upload_object(name));
create policy verified_download on storage.objects for select to authenticated using(bucket_id='request-files' and public.can_read_object(name));

revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.is_member(uuid),public.is_admin(uuid),public.can_upload_object(text),public.can_read_object(text) to authenticated;
grant execute on function public.handoff_context(),public.handoff_list(jsonb),public.handoff_get(uuid),public.handoff_create(jsonb,text),public.handoff_command(uuid,jsonb,text),public.handoff_start_review(uuid,integer,text),public.handoff_accept_membership(),public.handoff_invite(text,text),public.handoff_change_member(uuid,text,text),public.handoff_publish_checklist(text),public.handoff_reserve_file(uuid,text,text,bigint) to authenticated;
grant execute on function public.handoff_finish_review(uuid,uuid,jsonb,text,text),public.handoff_verify_file(uuid,uuid,boolean) to service_role;
commit;
