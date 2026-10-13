begin;

-- Google runs as the connector owner. It cannot approve or edit app requests.
create table public.workspace_connections (
  workspace_id uuid primary key references public.workspaces(id),
  owner_id uuid not null references auth.users(id), enabled boolean not null default true,
  form_id text, sheet_id text, folder_id text, last_sync_at timestamptz,
  foreign key(workspace_id,owner_id) references public.memberships(workspace_id,user_id)
);
create table public.workspace_submissions (
  workspace_id uuid not null references public.workspace_connections(workspace_id),
  response_id text not null, payload_hash text not null,
  request_id uuid not null references public.requests(id), created_at timestamptz not null default now(),
  primary key(workspace_id,response_id)
);
create table public.workspace_documents (
  brief_id uuid primary key references public.briefs(id),
  workspace_id uuid not null references public.workspace_connections(workspace_id),
  document_id text not null unique, content_hash text not null, created_at timestamptz not null default now()
);
create table public.workspace_bridge_nonces (
  workspace_id uuid not null references public.workspace_connections(workspace_id),
  nonce uuid not null, created_at timestamptz not null default now(), primary key(workspace_id,nonce)
);
alter table public.workspace_connections enable row level security;
alter table public.workspace_submissions enable row level security;
alter table public.workspace_documents enable row level security;
alter table public.workspace_bridge_nonces enable row level security;
create policy connection_read on public.workspace_connections for select to authenticated using(public.is_admin(workspace_id));
create policy document_read on public.workspace_documents for select to authenticated using(public.is_member(workspace_id));
revoke all on public.workspace_connections,public.workspace_submissions,public.workspace_documents,public.workspace_bridge_nonces from public,anon,authenticated;
grant select on public.workspace_connections,public.workspace_documents to authenticated;
grant all on public.workspace_connections,public.workspace_submissions,public.workspace_documents,public.workspace_bridge_nonces to service_role;

create function public.handoff_workspace_connection() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); c public.workspace_connections;
begin
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  select * into c from public.workspace_connections where workspace_id=w;
  if c.workspace_id is null then return null; end if;
  return jsonb_build_object('enabled',c.enabled,'formId',c.form_id,'sheetId',c.sheet_id,'folderId',c.folder_id,'lastSyncAt',c.last_sync_at);
end; $$;
create function public.handoff_workspace_enabled(p_enabled boolean) returns void language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  perform 1 from public.workspaces where id=w for update;
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  update public.workspace_connections set enabled=p_enabled where workspace_id=w;
  if not found then raise exception 'NOT_CONFIGURED|Google Workspace has not been connected.'; end if;
  insert into public.audit_events(workspace_id,actor_id,action) values(w,auth.uid(),case when p_enabled then 'workspace_resume' else 'workspace_pause' end);
end; $$;
create function public.handoff_google_document(p_brief uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.briefs; d public.workspace_documents;
begin
  select * into b from public.briefs where id=p_brief and public.is_member(workspace_id);
  if b.id is null then raise exception 'NOT_FOUND|This approved brief could not be found.'; end if;
  select * into d from public.workspace_documents where brief_id=b.id;
  if d.brief_id is null then return null; end if;
  return jsonb_build_object('documentId',d.document_id,'createdAt',d.created_at);
end; $$;

-- Each signed call gets one nonce. The same key is limited to 120 calls/minute.
create function public.workspace_bridge_nonce(p_workspace uuid,p_nonce uuid) returns void language plpgsql security definer set search_path='' as $$
declare c public.workspace_connections;
begin
  perform 1 from public.workspaces where id=p_workspace for update;
  select * into c from public.workspace_connections where workspace_id=p_workspace;
  if c.workspace_id is null or not c.enabled or not exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=c.owner_id and role='admin' and status='active') then
    raise exception 'ACCESS_DENIED|The Google Workspace connection is paused or its owner no longer has administrator access.';
  end if;
  delete from public.workspace_bridge_nonces where workspace_id=p_workspace and created_at<now()-interval '10 minutes';
  if exists(select 1 from public.workspace_bridge_nonces where workspace_id=p_workspace and nonce=p_nonce) then raise exception 'REPLAY|This signed request was already received.'; end if;
  if (select count(*) from public.workspace_bridge_nonces where workspace_id=p_workspace and created_at>now()-interval '1 minute')>=120 then raise exception 'RATE_LIMIT|Wait a minute before syncing again.'; end if;
  insert into public.workspace_bridge_nonces(workspace_id,nonce) values(p_workspace,p_nonce);
end; $$;

create function public.workspace_bridge(p_workspace uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.workspace_connections; actor uuid; checklist uuid; original_actor text;
  previous public.workspace_submissions; result jsonb; input jsonb; saved_brief public.briefs; saved_doc public.workspace_documents;
  rows jsonb; pending jsonb; cursor_number bigint:=0; next_number bigint; n integer;
begin
  perform 1 from public.workspaces where id=p_workspace for update;
  select * into c from public.workspace_connections where workspace_id=p_workspace;
  if c.workspace_id is null or not c.enabled or not exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=c.owner_id and role='admin' and status='active') then raise exception 'ACCESS_DENIED|The Google Workspace connection is unavailable.'; end if;
  if p_action='configure' then
    if coalesce(p_data->>'formId','')!~'^[A-Za-z0-9_-]{10,200}$' or coalesce(p_data->>'sheetId','')!~'^[A-Za-z0-9_-]{10,200}$' or coalesce(p_data->>'folderId','')!~'^[A-Za-z0-9_-]{10,200}$' then raise exception 'INVALID_INPUT|Google asset IDs are required.'; end if;
    if c.form_id is not null and (c.form_id<>p_data->>'formId' or c.sheet_id<>p_data->>'sheetId' or c.folder_id<>p_data->>'folderId') then raise exception 'KEY_REUSED|This connection is already bound to different Google assets.'; end if;
    update public.workspace_connections set form_id=p_data->>'formId',sheet_id=p_data->>'sheetId',folder_id=p_data->>'folderId' where workspace_id=p_workspace;
    return jsonb_build_object('configured',true);
  end if;
  if c.form_id is null then raise exception 'NOT_CONFIGURED|Run Google Workspace setup first.'; end if;
  if p_action='import' then
    if p_data->>'formId' is distinct from c.form_id then raise exception 'FORBIDDEN|This Form is not connected to this workspace.'; end if;
    if length(coalesce(p_data->>'responseId','')) not between 1 and 200 then raise exception 'INVALID_INPUT|A Form response ID is required.'; end if;
    select * into previous from public.workspace_submissions where workspace_id=p_workspace and response_id=p_data->>'responseId';
    if previous.request_id is not null then
      if previous.payload_hash<>public.json_hash(p_data) then raise exception 'KEY_REUSED|This Form response changed after import. Edit the request in HandoffCheck.'; end if;
      return jsonb_build_object('requestId',previous.request_id,'imported',false);
    end if;
    select u.id into actor from auth.users u join public.memberships m on m.user_id=u.id and m.workspace_id=p_workspace
      where lower(u.email)=lower(trim(p_data->>'email')) and u.email_confirmed_at is not null and m.status='active'
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google');
    if actor is null then raise exception 'ACCESS_DENIED|Sign in to HandoffCheck with an invited Google account before submitting this Form.'; end if;
    -- require_workspace uses the pilot's single-workspace membership rule.
    if (select workspace_id from public.memberships where user_id=actor and status='active' order by workspace_id limit 1)<>p_workspace then raise exception 'ACCESS_DENIED|This account belongs to a different workspace.'; end if;
    if (select count(*) from public.workspace_submissions where workspace_id=p_workspace and created_at>now()-interval '1 day')>=100 then raise exception 'RATE_LIMIT|The pilot allows 100 Google Form imports per day.'; end if;
    select id into checklist from public.checklist_versions where workspace_id=p_workspace order by created_at desc,id desc limit 1;
    input:=jsonb_build_object('fields',p_data->'fields','productReviewerId','','engineeringReviewerId','','checklistVersion',checklist,'fileIds','[]'::jsonb);
    -- Resolve the verified Google identity server-side, then reuse the canonical create transaction.
    original_actor:=current_setting('request.jwt.claim.sub',true);
    perform set_config('request.jwt.claim.sub',actor::text,true);
    result:=public.handoff_create(input,'google:'||public.json_hash(jsonb_build_object('form',c.form_id,'response',p_data->>'responseId')));
    perform set_config('request.jwt.claim.sub',coalesce(original_actor,''),true);
    insert into public.workspace_submissions(workspace_id,response_id,payload_hash,request_id) values(p_workspace,p_data->>'responseId',public.json_hash(p_data),(result->>'id')::uuid);
    insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(p_workspace,(result->>'id')::uuid,actor,'google_form_import',1);
    return jsonb_build_object('requestId',result->>'id','imported',true);
  elsif p_action='sync' then
    cursor_number:=coalesce((p_data->>'after')::bigint,0);
    select coalesce(jsonb_agg(public.summary_json(r)||jsonb_build_object('questions',coalesce((select jsonb_agg(f.body->>'question' order by f.id) from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=r.current_review_id and x.finding_id is null),'[]'),'documents',coalesce((select jsonb_agg(jsonb_build_object('revision',b.revision,'documentId',d.document_id) order by b.revision) from public.briefs b join public.workspace_documents d on d.brief_id=b.id where b.request_id=r.id),'[]')) order by r.number),'[]'),max(r.number),count(*) into rows,next_number,n
      from (select * from public.requests where workspace_id=p_workspace and number>cursor_number order by number limit 25) r;
    select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'requestId',b.request_id,'number',r.number,'revision',b.revision,'markdown',b.markdown,'contentHash',b.content_hash) order by r.number,b.revision),'[]') into pending
      from public.briefs b join public.requests r on r.id=b.request_id left join public.workspace_documents d on d.brief_id=b.id where b.workspace_id=p_workspace and d.brief_id is null and r.number>cursor_number and r.number<=next_number;
    return jsonb_build_object('requests',rows,'briefs',pending,'next',case when n=25 then next_number else null end);
  elsif p_action='document' then
    select * into saved_brief from public.briefs where id=(p_data->>'briefId')::uuid and workspace_id=p_workspace;
    if saved_brief.id is null then raise exception 'NOT_FOUND|Only a stored approved brief can be exported.'; end if;
    if saved_brief.content_hash is distinct from p_data->>'contentHash' then raise exception 'KEY_REUSED|The exported content does not match the approved brief.'; end if;
    if coalesce(p_data->>'documentId','')!~'^[A-Za-z0-9_-]{10,200}$' then raise exception 'INVALID_INPUT|A Google document ID is required.'; end if;
    select * into saved_doc from public.workspace_documents where brief_id=saved_brief.id;
    if saved_doc.brief_id is not null and saved_doc.document_id<>p_data->>'documentId' then raise exception 'KEY_REUSED|This brief already has a Google Doc.'; end if;
    insert into public.workspace_documents(brief_id,workspace_id,document_id,content_hash) values(saved_brief.id,p_workspace,p_data->>'documentId',saved_brief.content_hash) on conflict(brief_id) do nothing;
    if saved_doc.brief_id is null then insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(p_workspace,saved_brief.request_id,c.owner_id,'google_doc_export',saved_brief.revision); end if;
    return jsonb_build_object('saved',true);
  elsif p_action='complete' then
    update public.workspace_connections set last_sync_at=now() where workspace_id=p_workspace;
    return jsonb_build_object('synced',true);
  end if;
  raise exception 'INVALID_INPUT|Unknown Workspace action.';
end; $$;

revoke all on function public.handoff_workspace_connection(),public.handoff_workspace_enabled(boolean),public.handoff_google_document(uuid),public.workspace_bridge_nonce(uuid,uuid),public.workspace_bridge(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.handoff_workspace_connection(),public.handoff_workspace_enabled(boolean),public.handoff_google_document(uuid) to authenticated;
grant execute on function public.workspace_bridge_nonce(uuid,uuid),public.workspace_bridge(uuid,text,jsonb) to service_role;
commit;
