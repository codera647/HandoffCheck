-- Google's responder URL differs from its editor ID. Keep the published URL explicitly.
alter table public.workspace_connections add column form_url text
  check(form_url ~ '^https://docs\.google\.com/forms/d/(e/)?[A-Za-z0-9_-]{10,200}/viewform$');

create or replace function public.handoff_workspace_connection() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); c public.workspace_connections;
begin
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  select * into c from public.workspace_connections where workspace_id=w;
  if c.workspace_id is null then return null; end if;
  return jsonb_build_object('enabled',c.enabled,'formId',c.form_id,'formUrl',c.form_url,
    'sheetId',c.sheet_id,'folderId',c.folder_id,'lastSyncAt',c.last_sync_at);
end; $$;

-- Published by the owner in the existing pilot setup log. Scope the backfill to that exact binding.
update public.workspace_connections set form_url='https://docs.google.com/forms/d/e/1FAIpQLSdPemNIrCgPyRTDq5Tux_mY2MSj34Kq3fxiLfklteQUhe-0uw/viewform'
  where workspace_id='ae4d5cfe-1fcd-4300-9385-d368886e8b9c' and form_id='1LSV4gShz9yrbj_59ekvlnXXM7M2rG2BJEkBox_KuE4o' and form_url is null;

create or replace function public.workspace_bridge(p_workspace uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.workspace_connections; actor uuid; checklist uuid; original_actor text;
  previous public.workspace_submissions; result jsonb; input jsonb; saved_brief public.briefs; saved_doc public.workspace_documents;
  rows jsonb; pending jsonb; cursor_number bigint:=0; next_number bigint; n integer;
begin
  perform 1 from public.workspaces where id=p_workspace for update;
  select * into c from public.workspace_connections where workspace_id=p_workspace;
  if c.workspace_id is null or not c.enabled or not exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=c.owner_id and role='admin' and status='active') then raise exception 'ACCESS_DENIED|The Google Workspace connection is unavailable.'; end if;
  if p_action='configure' then
    if p_data ? 'formUrl' and (jsonb_typeof(p_data->'formUrl') is distinct from 'string' or coalesce(p_data->>'formUrl','')!~'^https://docs\.google\.com/forms/d/(e/)?[A-Za-z0-9_-]{10,200}/viewform$') then raise exception 'INVALID_INPUT|Use the published Google Form responder URL.'; end if;
    if coalesce(p_data->>'formId','')!~'^[A-Za-z0-9_-]{10,200}$' or coalesce(p_data->>'sheetId','')!~'^[A-Za-z0-9_-]{10,200}$' or coalesce(p_data->>'folderId','')!~'^[A-Za-z0-9_-]{10,200}$' then raise exception 'INVALID_INPUT|Google asset IDs are required.'; end if;
    if c.form_id is not null and (c.form_id<>p_data->>'formId' or c.sheet_id<>p_data->>'sheetId' or c.folder_id<>p_data->>'folderId') then raise exception 'KEY_REUSED|This connection is already bound to different Google assets.'; end if;
    update public.workspace_connections set form_id=p_data->>'formId',sheet_id=p_data->>'sheetId',folder_id=p_data->>'folderId',form_url=coalesce(p_data->>'formUrl',form_url) where workspace_id=p_workspace;
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
