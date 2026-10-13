begin;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(), name text not null,
  timezone text not null default 'Asia/Karachi', review_mode text not null default 'checklist_only' check (review_mode in ('checklist_only','ai')),
  retention_days integer not null default 60 check (retention_days between 7 and 365), created_at timestamptz not null default now()
);
create table public.memberships (
  workspace_id uuid not null references public.workspaces(id), user_id uuid not null references auth.users(id),
  name text not null check (length(name) between 1 and 100), role text not null check (role in ('member','product_lead','engineering_lead','admin')),
  status text not null default 'active' check (status in ('active','revoked')), primary key (workspace_id,user_id)
);
create table public.invitations (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), email text not null,
  role text not null check (role in ('member','product_lead','engineering_lead','admin')), invited_by uuid references auth.users(id),
  expires_at timestamptz not null default now()+interval '7 days', consumed_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create unique index invitations_pending_email on public.invitations(workspace_id,email) where consumed_by is null;
create table public.checklist_versions (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), name text not null,
  required_fields jsonb not null default '["title","problem","audience","behavior","scope","exclusions","criteria","edgeCases","dependencies","dataImpact","successMeasure","rationale"]',
  created_at timestamptz not null default now(), unique(id,workspace_id)
);
create table public.requests (
  id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
  workspace_id uuid not null references public.workspaces(id), author_id uuid not null references auth.users(id),
  current_revision integer not null default 1, current_review_id uuid, minimum_approval_revision integer not null default 1,
  status text not null default 'draft' check (status in ('draft','reviewing','needs_clarification','review_error','ready_for_approval','partially_approved','approved','brief_ready')),
  archived boolean not null default false, updated_at timestamptz not null default now(), unique(id,workspace_id)
);
create table public.request_revisions (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, number integer not null,
  fields jsonb not null, product_reviewer_id uuid, engineering_reviewer_id uuid, checklist_id uuid not null, input_hash text not null,
  files jsonb not null default '[]', created_at timestamptz not null default now(), editor_id uuid not null references auth.users(id),
  unique(request_id,number), unique(id,workspace_id), foreign key(request_id,workspace_id) references public.requests(id,workspace_id),
  foreign key(checklist_id,workspace_id) references public.checklist_versions(id,workspace_id)
);
create table public.review_runs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, revision integer not null, input_hash text not null,
  state text not null default 'running' check (state in ('running','succeeded','error','superseded')),
  mode text not null check(mode in ('checklist_only','ai')), lease_token uuid not null default gen_random_uuid(), expires_at timestamptz not null default now()+interval '90 seconds',
  actor_id uuid not null references auth.users(id), model_id text, prompt_version text not null default 'feature-review-v1', unknowns jsonb not null default '[]',
  error text, created_at timestamptz not null default now(), unique(id,workspace_id),
  foreign key(request_id,workspace_id) references public.requests(id,workspace_id), foreign key(request_id,revision) references public.request_revisions(request_id,number)
);
alter table public.requests add constraint current_review_fk foreign key(current_review_id) references public.review_runs(id);
create unique index one_running_review on public.review_runs(request_id,revision) where state='running';
create table public.findings (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, review_id uuid not null,
  body jsonb not null, foreign key(review_id,workspace_id) references public.review_runs(id,workspace_id), unique(id,workspace_id)
);
create table public.finding_resolutions (
  finding_id uuid primary key references public.findings(id), workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null references auth.users(id), reason text not null check(length(reason) between 1 and 1000), created_at timestamptz not null default now()
);
create table public.approvals (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, review_id uuid not null,
  revision integer not null, input_hash text not null, stage text not null check(stage in ('product','engineering')), member_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
  unique(review_id,stage), foreign key(review_id,workspace_id) references public.review_runs(id,workspace_id), foreign key(request_id,workspace_id) references public.requests(id,workspace_id)
);
create table public.briefs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, revision integer not null,
  review_id uuid not null, product_approval_id uuid not null references public.approvals(id), engineering_approval_id uuid not null references public.approvals(id),
  markdown text not null, content_hash text not null, template_version text not null default 'brief-v1', created_at timestamptz not null default now(),
  unique(request_id,revision), foreign key(review_id,workspace_id) references public.review_runs(id,workspace_id), foreign key(request_id,workspace_id) references public.requests(id,workspace_id)
);
create table public.comments (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, author_id uuid not null references auth.users(id),
  revision integer not null, body text not null check(length(body) between 1 and 3000), created_at timestamptz not null default now(),
  foreign key(request_id,workspace_id) references public.requests(id,workspace_id)
);
create table public.stored_files (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null, request_id uuid not null, owner_id uuid not null references auth.users(id),
  name text not null check(length(name) between 1 and 250), type text not null check(type in ('image/png','image/jpeg','application/pdf')),
  size bigint not null check(size between 1 and 5000000), path text not null unique,
  state text not null default 'pending' check(state in ('pending','verified','rejected')), expires_at timestamptz not null default now()+interval '30 minutes', created_at timestamptz not null default now(),
  foreign key(request_id,workspace_id) references public.requests(id,workspace_id)
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), request_id uuid,
  actor_id uuid references auth.users(id), action text not null, revision integer not null default 0, created_at timestamptz not null default now()
);
create table public.command_receipts (
  workspace_id uuid not null references public.workspaces(id), actor_id uuid not null references auth.users(id), key text not null check(length(key) between 1 and 128),
  operation text not null, payload_hash text not null, request_id uuid references public.requests(id), result jsonb,
  created_at timestamptz not null default now(), primary key(workspace_id,actor_id,operation,key)
);
create index request_workspace_updated on public.requests(workspace_id,archived,updated_at desc,id);
create index review_quota on public.review_runs(workspace_id,actor_id,created_at);
create index comments_request on public.comments(request_id,created_at);
create index audit_request on public.audit_events(request_id,created_at);
create index files_workspace on public.stored_files(workspace_id,state);

-- All policy helpers derive the actor from the verified database JWT.
create function public.is_member(p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=auth.uid() and status='active');
$$;
create function public.is_admin(p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=auth.uid() and status='active' and role='admin');
$$;
create function public.require_workspace() returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_id uuid;
begin
  select workspace_id into v_id from public.memberships where user_id=auth.uid() and status='active' order by workspace_id limit 1;
  if v_id is null then raise exception 'ACCESS_DENIED|Your workspace access is unavailable.' using errcode='P0001'; end if;
  return v_id;
end; $$;
create function public.canonical_json(p_value jsonb) returns text language plpgsql immutable set search_path='' as $$
declare v_text text;
begin
  if jsonb_typeof(p_value)='object' then
    select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.canonical_json(value),',' order by key collate "C"),'')||'}' into v_text from jsonb_each(p_value);
  elsif jsonb_typeof(p_value)='array' then
    select '['||coalesce(string_agg(public.canonical_json(value),',' order by ord),'')||']' into v_text from jsonb_array_elements(p_value) with ordinality as x(value,ord);
  else v_text:=p_value::text; end if;
  return v_text;
end; $$;
create function public.json_hash(p_value jsonb) returns text language sql immutable set search_path='' as $$ select encode(sha256(convert_to(public.canonical_json(p_value),'UTF8')),'hex'); $$;

do $$ declare t text; begin
  foreach t in array array['workspaces','memberships','checklist_versions','requests','request_revisions','review_runs','findings','finding_resolutions','approvals','briefs','comments','stored_files','audit_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy workspace_read on public.%I for select to authenticated using (public.is_member(%I))',t,case when t='workspaces' then 'id' else 'workspace_id' end);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end; $$;
alter table public.invitations enable row level security;
create policy admin_read on public.invitations for select to authenticated using(public.is_admin(workspace_id));
grant select on public.invitations to authenticated;
alter table public.command_receipts enable row level security;
-- No client INSERT/UPDATE/DELETE grants or policies on domain tables.
revoke all on all tables in schema public from anon;
revoke insert,update,delete,truncate on all tables in schema public from authenticated;

create function public.member_json(p_row public.memberships) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',p_row.user_id,'name',p_row.name,'role',p_row.role,'status',p_row.status);
$$;
create function public.revision_json(p_row public.request_revisions) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'number',p_row.number,'fields',p_row.fields,'productReviewerId',coalesce(p_row.product_reviewer_id::text,''),'engineeringReviewerId',coalesce(p_row.engineering_reviewer_id::text,''),'checklistVersion',p_row.checklist_id,'requiredFields',(select required_fields from public.checklist_versions where id=p_row.checklist_id),'inputHash',p_row.input_hash,'files',p_row.files,'createdAt',p_row.created_at,'editorId',p_row.editor_id);
$$;
create function public.review_json(p_row public.review_runs) returns jsonb language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object('id',p_row.id,'revision',p_row.revision,'inputHash',p_row.input_hash,'state',case when p_row.state='running' and p_row.expires_at<now() then 'error' else p_row.state end,'mode',p_row.mode,'unknowns',p_row.unknowns,'createdAt',p_row.created_at,'expiresAt',p_row.expires_at,'error',case when p_row.state='running' and p_row.expires_at<now() then 'The review timed out. Try again.' else p_row.error end,'modelId',p_row.model_id,'promptVersion',p_row.prompt_version,
  'findings',coalesce((select jsonb_agg(jsonb_build_object('id',f.id)||f.body||case when x.finding_id is not null then jsonb_build_object('resolution',jsonb_build_object('actorId',x.actor_id,'reason',x.reason,'createdAt',x.created_at)) else '{}'::jsonb end order by f.id) from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=p_row.id),'[]')));
$$;
create function public.summary_json(p_row public.requests) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'number',p_row.number,'title',coalesce(nullif(r.fields->>'title',''),'Untitled feature'),'authorId',p_row.author_id,'productReviewerId',coalesce(r.product_reviewer_id::text,''),'engineeringReviewerId',coalesce(r.engineering_reviewer_id::text,''),'status',case when p_row.status='reviewing' and exists(select 1 from public.review_runs where id=p_row.current_review_id and state='running' and expires_at<now()) then 'review_error' else p_row.status end,'currentRevision',p_row.current_revision,'updatedAt',p_row.updated_at,'archived',p_row.archived,
  'blockingCount',(select count(*) from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=p_row.current_review_id and f.body->>'severity'='blocking' and x.finding_id is null)) from public.request_revisions r where r.request_id=p_row.id and r.number=p_row.current_revision;
$$;
create function public.handoff_get(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.requests; result jsonb;
begin
  select * into r from public.requests where id=p_id and public.is_member(workspace_id);
  if r.id is null then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  result:=public.summary_json(r)||jsonb_build_object('workspaceId',r.workspace_id,'currentReviewId',r.current_review_id,'minimumApprovalRevision',r.minimum_approval_revision,
  'revisions',coalesce((select jsonb_agg(public.revision_json(x) order by x.number) from public.request_revisions x where request_id=r.id),'[]'),
  'reviews',coalesce((select jsonb_agg(public.review_json(x) order by x.created_at) from public.review_runs x where request_id=r.id),'[]'),
  'approvals',coalesce((select jsonb_agg(jsonb_build_object('id',id,'reviewId',review_id,'revision',revision,'inputHash',input_hash,'stage',stage,'memberId',member_id,'createdAt',created_at) order by created_at) from public.approvals where request_id=r.id),'[]'),
  'briefs',coalesce((select jsonb_agg(jsonb_build_object('id',id,'revision',revision,'reviewId',review_id,'markdown',markdown,'contentHash',content_hash,'createdAt',created_at) order by created_at) from public.briefs where request_id=r.id),'[]'),
  'comments',coalesce((select jsonb_agg(jsonb_build_object('id',id,'authorId',author_id,'body',body,'revision',revision,'createdAt',created_at) order by created_at) from public.comments where request_id=r.id),'[]'),
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',id,'actorId',actor_id,'action',action,'revision',revision,'createdAt',created_at) order by created_at) from public.audit_events where request_id=r.id),'[]'));
  return result;
end; $$;
create function public.handoff_context() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w public.workspaces; m public.memberships; c public.checklist_versions;
begin
  select * into w from public.workspaces where id=public.require_workspace();
  select * into m from public.memberships where workspace_id=w.id and user_id=auth.uid();
  select * into c from public.checklist_versions where workspace_id=w.id order by created_at desc,id desc limit 1;
  return jsonb_strip_nulls(jsonb_build_object('workspace',jsonb_build_object('id',w.id,'name',w.name,'timezone',w.timezone,'reviewMode',w.review_mode,'retentionDays',w.retention_days,'storageBytes',(select coalesce(sum(size),0) from public.stored_files where workspace_id=w.id)),
  'currentUser',public.member_json(m),'members',(select coalesce(jsonb_agg(public.member_json(x) order by name),'[]') from public.memberships x where workspace_id=w.id),
  'checklist',jsonb_build_object('id',c.id,'name',c.name,'requiredFields',c.required_fields,'createdAt',c.created_at),
  'invitations',case when m.role='admin' then (select coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'role',role,'expiresAt',expires_at,'consumed',consumed_by is not null)),'[]') from public.invitations where workspace_id=w.id) else null end));
end; $$;
create function public.handoff_list(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); p integer:=greatest(1,least(10000,coalesce((p_filters->>'page')::integer,1))); result jsonb; n integer;
begin
  with filtered as (
    select r.* from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    where r.workspace_id=w and r.archived=coalesce((p_filters->>'archived')::boolean,false)
    and (coalesce(p_filters->>'search','')='' or position(lower(p_filters->>'search') in lower(coalesce(v.fields->>'title','')||' HC-'||lpad(r.number::text,4,'0')))>0)
    and (coalesce(p_filters->>'status','')='' or r.status=p_filters->>'status')
    and (coalesce(p_filters->>'author','')='' or r.author_id::text=p_filters->>'author')
    and (coalesce(p_filters->>'assigned','')='' or v.product_reviewer_id::text=p_filters->>'assigned' or v.engineering_reviewer_id::text=p_filters->>'assigned')
  ) select count(*) into n from filtered;
  select coalesce(jsonb_agg(public.summary_json(x) order by x.updated_at desc,x.number desc),'[]') into result from (
    select r.* from public.requests r join public.request_revisions v on v.request_id=r.id and v.number=r.current_revision
    where r.workspace_id=w and r.archived=coalesce((p_filters->>'archived')::boolean,false)
    and (coalesce(p_filters->>'search','')='' or position(lower(p_filters->>'search') in lower(coalesce(v.fields->>'title','')||' HC-'||lpad(r.number::text,4,'0')))>0)
    and (coalesce(p_filters->>'status','')='' or r.status=p_filters->>'status')
    and (coalesce(p_filters->>'author','')='' or r.author_id::text=p_filters->>'author')
    and (coalesce(p_filters->>'assigned','')='' or v.product_reviewer_id::text=p_filters->>'assigned' or v.engineering_reviewer_id::text=p_filters->>'assigned')
    order by r.updated_at desc,r.number desc limit 25 offset (p-1)*25
  ) x;
  return jsonb_build_object('items',result,'total',n,'page',p,'pageSize',25);
end; $$;

-- Shared write helpers are private to other database functions.
create function public.assert_revision(p_request public.requests,p_expected integer) returns void language plpgsql set search_path='' as $$
begin
  if p_request.id is null or not public.is_member(p_request.workspace_id) then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  if p_expected is null or p_request.current_revision<>p_expected then raise exception 'REVISION_CHANGED|This request changed. Reload it before continuing.'; end if;
end; $$;
create function public.assert_reviewers(p_request public.requests,p_revision public.request_revisions) returns void language plpgsql set search_path='' as $$
begin
  if p_revision.product_reviewer_id is null or p_revision.engineering_reviewer_id is null or p_revision.product_reviewer_id=p_revision.engineering_reviewer_id or p_revision.product_reviewer_id=p_request.author_id or p_revision.engineering_reviewer_id=p_request.author_id
  or not exists(select 1 from public.memberships where workspace_id=p_request.workspace_id and user_id=p_revision.product_reviewer_id and status='active' and role='product_lead')
  or not exists(select 1 from public.memberships where workspace_id=p_request.workspace_id and user_id=p_revision.engineering_reviewer_id and status='active' and role='engineering_lead')
  then raise exception 'REVIEWER_ASSIGNMENT|Assign two active leads, each different from the author.'; end if;
end; $$;
create function public.is_assigned(p_request public.requests,p_revision public.request_revisions) returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from public.memberships where workspace_id=p_request.workspace_id and user_id=auth.uid() and status='active' and ((role='product_lead' and user_id=p_revision.product_reviewer_id) or (role='engineering_lead' and user_id=p_revision.engineering_reviewer_id)));
$$;
create function public.insert_revision(p_request public.requests,p_draft jsonb,p_number integer) returns void language plpgsql set search_path='' as $$
declare f jsonb:=p_draft->'fields'; c public.checklist_versions; attachments jsonb; hash text; key text; value jsonb; files_count integer;
begin
  if jsonb_typeof(f) is distinct from 'object' or octet_length(f::text)>24000 then raise exception 'INVALID_INPUT|Keep the request text below 24 KB.'; end if;
  foreach key in array array['title','problem','audience','behavior','scope','exclusions','edgeCases','dependencies','dataImpact','successMeasure','rationale','targetDate','timezone','priority'] loop
    if jsonb_typeof(f->key)<>'string' or f->key is null or length(f->>key)>(case when key='title' then 120 when key='timezone' then 80 else 3000 end) then raise exception 'INVALID_INPUT|Invalid or oversized request field.'; end if;
  end loop;
  if f->>'priority' not in ('low','normal','high') or jsonb_typeof(f->'unscheduled') is distinct from 'boolean' or jsonb_typeof(f->'criteria') is distinct from 'array' or jsonb_typeof(f->'references') is distinct from 'array' then raise exception 'INVALID_INPUT|Invalid request fields.'; end if;
  if not exists(select 1 from pg_catalog.pg_timezone_names where name=f->>'timezone') then raise exception 'INVALID_INPUT|Choose a valid timezone.'; end if;
  if not (f->>'unscheduled')::boolean and (coalesce(f->>'targetDate','')='' or f->>'targetDate'!~'^\d{4}-\d{2}-\d{2}$') then raise exception 'INVALID_INPUT|Add a target date or choose not scheduled.'; end if;
  if jsonb_array_length(f->'criteria')>20 or jsonb_array_length(f->'references')>10 then raise exception 'INVALID_INPUT|Too many criteria or references.'; end if;
  for value in select * from jsonb_array_elements(f->'criteria') loop if jsonb_typeof(value)<>'string' or length(value#>>'{}')>1000 then raise exception 'INVALID_INPUT|Invalid acceptance criterion.'; end if; end loop;
  for value in select * from jsonb_array_elements(f->'references') loop if jsonb_typeof(value)<>'object' or jsonb_typeof(value->'url')<>'string' or jsonb_typeof(value->'label')<>'string' or length(value->>'label')>120 or value->>'url'!~'^https://[^\s]+$' then raise exception 'INVALID_INPUT|Use valid HTTPS reference links.'; end if; end loop;
  select * into c from public.checklist_versions where id=(p_draft->>'checklistVersion')::uuid and workspace_id=p_request.workspace_id;
  if c.id is null then raise exception 'CHECKLIST_VERSION|Choose a published checklist.'; end if;
  if jsonb_typeof(p_draft->'fileIds') is distinct from 'array' then raise exception 'INVALID_INPUT|Invalid attachment list.'; end if;
  files_count:=jsonb_array_length(p_draft->'fileIds');
  if files_count>5 or files_count<>(select count(distinct t.value) from jsonb_array_elements_text(p_draft->'fileIds') t(value)) then raise exception 'FILE_LIMIT|Attach up to five different files.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'name',x.name,'type',x.type,'size',x.size) order by x.id),'[]') into attachments from public.stored_files x where x.request_id=p_request.id and x.state='verified' and x.id::text in (select jsonb_array_elements_text(p_draft->'fileIds'));
  if jsonb_array_length(attachments)<>files_count then raise exception 'FILE_NOT_READY|Finish uploading files before saving.'; end if;
  hash:=public.json_hash(jsonb_build_object('fields',f,'productReviewerId',coalesce(p_draft->>'productReviewerId',''),'engineeringReviewerId',coalesce(p_draft->>'engineeringReviewerId',''),'checklistVersion',c.id,'files',attachments));
  insert into public.request_revisions(workspace_id,request_id,number,fields,product_reviewer_id,engineering_reviewer_id,checklist_id,input_hash,files,editor_id)
  values(p_request.workspace_id,p_request.id,p_number,f,nullif(p_draft->>'productReviewerId','')::uuid,nullif(p_draft->>'engineeringReviewerId','')::uuid,c.id,hash,attachments,auth.uid());
end; $$;
create function public.receipt(p_workspace uuid,p_operation text,p_key text,p_body jsonb) returns public.command_receipts language plpgsql set search_path='' as $$
declare result public.command_receipts;
begin
  if p_key is null or length(p_key) not between 1 and 128 then raise exception 'INVALID_KEY|An idempotency key is required.'; end if;
  -- Serialize command keys before they can create separate requests.
  perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||auth.uid()::text||p_operation||p_key,0));
  select * into result from public.command_receipts where workspace_id=p_workspace and actor_id=auth.uid() and operation=p_operation and key=p_key;
  if result.key is not null and result.payload_hash<>public.json_hash(p_body) then raise exception 'KEY_REUSED|This command key was reused with different content.'; end if;
  return result;
end; $$;
create function public.handoff_create(p_draft jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); r public.requests; x public.command_receipts;
begin
  x:=public.receipt(w,'create',p_key,p_draft);
  perform 1 from public.workspaces where id=w for update;
  if not public.is_member(w) then raise exception 'ACCESS_DENIED|Your workspace access is unavailable.'; end if;
  if x.key is not null then return public.handoff_get(x.request_id); end if;
  insert into public.requests(workspace_id,author_id) values(w,auth.uid()) returning * into r;
  perform public.insert_revision(r,p_draft,1);
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(w,r.id,auth.uid(),'create',1);
  insert into public.command_receipts(workspace_id,actor_id,key,operation,payload_hash,request_id) values(w,auth.uid(),p_key,'create',public.json_hash(p_draft),r.id);
  return public.handoff_get(r.id);
end; $$;

create function public.handoff_command(p_id uuid,p_command jsonb,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.requests; v public.request_revisions; run public.review_runs; rec public.command_receipts; action text:=p_command->>'action'; target_stage text; approved_count integer; finding public.findings; markdown text; prod uuid; eng uuid; brief_id uuid;
begin
  select * into r from public.requests where id=p_id and public.is_member(workspace_id) for update;
  if r.id is null then raise exception 'NOT_FOUND|This request could not be found.'; end if;
  rec:=public.receipt(r.workspace_id,p_id::text||':'||action,p_key,p_command);
  if rec.key is not null then return public.handoff_get(r.id); end if;
  perform public.assert_revision(r,(p_command->>'expectedRevision')::integer);
  -- Serialize access changes with every write, then recheck current membership.
  perform 1 from public.workspaces where id=r.workspace_id for update;
  perform public.assert_revision(r,(p_command->>'expectedRevision')::integer);
  if r.archived and action<>'archive' then raise exception 'ARCHIVED|Restore this request before making changes.'; end if;
  select * into v from public.request_revisions where request_id=r.id and number=r.current_revision;
  select * into run from public.review_runs where id=r.current_review_id;
  if action='save' then
    if auth.uid()<>r.author_id then raise exception 'FORBIDDEN|Only the author can edit requirements.'; end if;
    perform public.insert_revision(r,p_command->'draft',r.current_revision+1);
    update public.requests set current_revision=current_revision+1,current_review_id=null,status='draft' where id=r.id;
  elsif action='comment' then
    insert into public.comments(workspace_id,request_id,author_id,revision,body) values(r.workspace_id,r.id,auth.uid(),r.current_revision,btrim(p_command->>'body'));
  elsif action='archive' then
    if auth.uid()<>r.author_id and not public.is_admin(r.workspace_id) then raise exception 'FORBIDDEN|Only the author or administrator can archive requests.'; end if;
    update public.requests set archived=(p_command->>'archived')::boolean where id=r.id;
  elsif action='changes' then
    if not public.is_assigned(r,v) then raise exception 'FORBIDDEN|Only an assigned lead can request changes.'; end if;
    if exists(select 1 from public.briefs where request_id=r.id and revision=r.current_revision) then raise exception 'BRIEF_EXISTS|The author must create a new revision after an approved brief.'; end if;
    if length(btrim(p_command->>'reason')) not between 1 and 3000 then raise exception 'INVALID_INPUT|Explain the requested changes.'; end if;
    insert into public.comments(workspace_id,request_id,author_id,revision,body) values(r.workspace_id,r.id,auth.uid(),r.current_revision,btrim(p_command->>'reason'));
    update public.requests set minimum_approval_revision=current_revision+1,current_review_id=null,status='needs_clarification' where id=r.id;
  elsif action='dismiss' then
    if not public.is_assigned(r,v) then raise exception 'FORBIDDEN|Only assigned leads can dismiss an AI finding.'; end if;
    select * into finding from public.findings where id=(p_command->>'findingId')::uuid and review_id=r.current_review_id;
    if run.id is null or run.id::text is distinct from p_command->>'reviewId' or run.state<>'succeeded' or finding.id is null or finding.body->>'origin'<>'ai' then raise exception 'INVALID_FINDING|This finding cannot be dismissed.'; end if;
    insert into public.finding_resolutions(finding_id,workspace_id,actor_id,reason) values(finding.id,r.workspace_id,auth.uid(),btrim(p_command->>'reason')) on conflict(finding_id) do nothing;
    if not exists(select 1 from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=run.id and f.body->>'severity'='blocking' and x.finding_id is null) then
      select count(*) into approved_count from public.approvals where review_id=run.id;
      update public.requests set status=case when approved_count=2 then 'approved' when approved_count=1 then 'partially_approved' else 'ready_for_approval' end where id=r.id;
    end if;
  elsif action='approve' then
    perform public.assert_reviewers(r,v);
    target_stage:=p_command->>'stage';
    if auth.uid()=r.author_id or not public.is_assigned(r,v) or (target_stage='product' and auth.uid()<>v.product_reviewer_id) or (target_stage='engineering' and auth.uid()<>v.engineering_reviewer_id) or target_stage not in ('product','engineering') then raise exception 'FORBIDDEN|Only the assigned lead can approve this stage.'; end if;
    if run.id is null or run.id::text is distinct from p_command->>'reviewId' or run.state<>'succeeded' or run.input_hash<>v.input_hash or run.revision<>v.number or r.current_revision<r.minimum_approval_revision or r.status not in ('ready_for_approval','partially_approved','approved','brief_ready') then raise exception 'NOT_READY|Review this revision before approval.'; end if;
    if exists(select 1 from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=run.id and f.body->>'severity'='blocking' and x.finding_id is null) then raise exception 'NOT_READY|Resolve the current blocking questions before approval.'; end if;
    insert into public.approvals(workspace_id,request_id,review_id,revision,input_hash,stage,member_id) values(r.workspace_id,r.id,run.id,v.number,v.input_hash,target_stage,auth.uid()) on conflict(review_id,stage) do nothing;
    select count(*) into approved_count from public.approvals where review_id=run.id;
    update public.requests set status=case when approved_count=2 then case when exists(select 1 from public.briefs where request_id=r.id and revision=v.number) then 'brief_ready' else 'approved' end else 'partially_approved' end where id=r.id;
  elsif action='generate' then
    if auth.uid()<>r.author_id and not public.is_assigned(r,v) then raise exception 'FORBIDDEN|Only the author or assigned leads can generate a brief.'; end if;
    select id into brief_id from public.briefs where request_id=r.id and revision=v.number;
    if brief_id is null then
      perform public.assert_reviewers(r,v);
      select id into prod from public.approvals where review_id=r.current_review_id and stage='product' and member_id=v.product_reviewer_id and input_hash=v.input_hash and revision=v.number;
      select id into eng from public.approvals where review_id=r.current_review_id and stage='engineering' and member_id=v.engineering_reviewer_id and input_hash=v.input_hash and revision=v.number;
      if r.status<>'approved' or prod is null or eng is null then raise exception 'NOT_APPROVED|Both leads must approve this revision before generating a brief.'; end if;
      markdown:=public.brief_markdown(r,v);
      insert into public.briefs(workspace_id,request_id,revision,review_id,product_approval_id,engineering_approval_id,markdown,content_hash) values(r.workspace_id,r.id,v.number,r.current_review_id,prod,eng,markdown,encode(sha256(convert_to(markdown,'UTF8')),'hex'));
      update public.requests set status='brief_ready' where id=r.id;
    end if;
  else raise exception 'INVALID_COMMAND|Unknown workflow command.'; end if;
  update public.requests set updated_at=now() where id=r.id returning * into r;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(r.workspace_id,r.id,auth.uid(),action,r.current_revision);
  insert into public.command_receipts(workspace_id,actor_id,key,operation,payload_hash,request_id) values(r.workspace_id,auth.uid(),p_key,p_id::text||':'||action,public.json_hash(p_command),r.id);
  return public.handoff_get(r.id);
end; $$;

-- Only explicitly selected RPCs are callable by a browser or user-scoped API.
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.is_member(uuid),public.is_admin(uuid) to authenticated;
grant execute on function public.handoff_context(),public.handoff_list(jsonb),public.handoff_get(uuid),public.handoff_create(jsonb,text),public.handoff_command(uuid,jsonb,text) to authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;

commit;
