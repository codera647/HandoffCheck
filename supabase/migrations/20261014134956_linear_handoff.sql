-- One immutable approved artifact, one persisted external UUID, explicit human confirmation.
create table public.linear_connections (
  workspace_id uuid primary key references public.workspaces(id), version integer not null default 1,
  organization_id uuid not null, organization_name text not null check(length(organization_name) between 1 and 200),
  team_id uuid not null, team_name text not null check(length(team_name) between 1 and 200),
  changed_by uuid not null references auth.users(id), changed_at timestamptz not null default now()
);
create table public.linear_handoffs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  brief_id uuid not null unique references public.briefs(id), actor_id uuid not null references auth.users(id),
  issue_id uuid not null unique default gen_random_uuid(), payload jsonb not null, payload_hash text not null,
  state text not null check(state in ('creating','created','failed')), lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now()+interval '90 seconds', attempts integer not null default 1,
  issue_url text check(issue_url ~ '^https://linear\.app/[^[:space:]]+$'), issue_identifier text,
  error text, created_at timestamptz not null default now()
);
alter table public.linear_connections enable row level security;
alter table public.linear_handoffs enable row level security;
revoke all on public.linear_connections,public.linear_handoffs from anon,authenticated;
grant all on public.linear_connections,public.linear_handoffs to service_role;
create index linear_handoff_workspace on public.linear_handoffs(workspace_id,created_at);

create function public.linear_connection() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace(); c public.linear_connections;
begin
  select * into c from public.linear_connections where workspace_id=w;
  return jsonb_build_object('organizationId',c.organization_id,'organizationName',c.organization_name,
    'teamId',c.team_id,'teamName',c.team_name,'version',coalesce(c.version,0));
end; $$;
create function public.linear_admin() returns uuid language plpgsql stable security definer set search_path='' as $$
declare w uuid:=public.require_workspace();
begin
  if not public.is_admin(w) then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  return w;
end; $$;
-- Metadata comes from the authenticated provider response, never arbitrary client text.
create function public.linear_configure(p_actor uuid,p_workspace uuid,p_organization uuid,p_name text,p_team uuid,p_team_name text,p_expected integer) returns void language plpgsql security definer set search_path='' as $$
declare c public.linear_connections;
begin
  perform 1 from public.workspaces where id=p_workspace for update;
  if not exists(select 1 from public.memberships where workspace_id=p_workspace and user_id=p_actor and status='active' and role='admin') then raise exception 'FORBIDDEN|Administrator access is required.'; end if;
  select * into c from public.linear_connections where workspace_id=p_workspace;
  if coalesce(c.version,0) is distinct from p_expected then raise exception 'DESTINATION_CHANGED|Reload the Linear destination before saving.'; end if;
  insert into public.linear_connections(workspace_id,organization_id,organization_name,team_id,team_name,changed_by)
    values(p_workspace,p_organization,p_name,p_team,p_team_name,p_actor)
    on conflict(workspace_id) do update set organization_id=excluded.organization_id,organization_name=excluded.organization_name,
      team_id=excluded.team_id,team_name=excluded.team_name,changed_by=p_actor,changed_at=now(),version=public.linear_connections.version+1;
  insert into public.audit_events(workspace_id,actor_id,action) values(p_workspace,p_actor,'linear_destination_changed');
end; $$;
create function public.linear_preview_for(p_actor uuid,p_brief uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b public.briefs; r public.requests; v public.request_revisions; c public.linear_connections; t public.linear_handoffs; payload jsonb;
begin
  select * into b from public.briefs where id=p_brief;
  select * into r from public.requests where id=b.request_id;
  if not exists(select 1 from public.memberships where workspace_id=b.workspace_id and user_id=p_actor and status='active') then raise exception 'NOT_FOUND|This approved brief could not be found.'; end if;
  select * into v from public.request_revisions where request_id=r.id and number=b.revision;
  select * into t from public.linear_handoffs where brief_id=b.id;
  if t.id is not null then
    payload:=t.payload;
  else
    select * into c from public.linear_connections where workspace_id=b.workspace_id;
    if c.workspace_id is null then raise exception 'NOT_CONFIGURED|Select a Linear team in Settings first.'; end if;
    payload:=jsonb_build_object('briefId',b.id,'revision',b.revision,'contentHash',b.content_hash,
      'organizationId',c.organization_id,'organizationName',c.organization_name,'teamId',c.team_id,'teamName',c.team_name,
      'title','HC-'||lpad(r.number::text,4,'0')||': '||(v.fields->>'title'),
      'description',b.markdown||E'\n\nSource: https://handoffcheck.vercel.app/briefs/'||r.id::text||'/'||b.id::text||E'\nArtifact SHA-256: '||b.content_hash);
  end if;
  return payload||jsonb_build_object('payloadHash',public.json_hash(payload),'state',coalesce(t.state,'preview'),
    'issueUrl',t.issue_url,'issueIdentifier',t.issue_identifier,'error',t.error);
end; $$;
create function public.linear_preview(p_brief uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform public.require_workspace();
  return public.linear_preview_for(auth.uid(),p_brief);
end; $$;
create function public.linear_assert_source(p_actor uuid,p_brief uuid) returns void language plpgsql stable security definer set search_path='' as $$
declare b public.briefs; r public.requests; v public.request_revisions;
begin
  select * into b from public.briefs where id=p_brief;
  select * into r from public.requests where id=b.request_id;
  select * into v from public.request_revisions where request_id=r.id and number=b.revision;
  if not exists(select 1 from public.memberships m where m.workspace_id=b.workspace_id and m.user_id=p_actor and m.status='active'
    and (p_actor=r.author_id or m.role='product_lead' and p_actor=v.product_reviewer_id or m.role='engineering_lead' and p_actor=v.engineering_reviewer_id))
    then raise exception 'FORBIDDEN|Only the author or assigned leads can send this brief to Linear.'; end if;
  if r.archived or r.current_revision<>b.revision or r.current_review_id<>b.review_id or r.status not in ('approved','brief_ready')
    then raise exception 'NOT_CURRENT|Only the current approved brief can be sent to Linear.'; end if;
  perform public.assert_reviewers(r,v);
end; $$;
create function public.linear_claim(p_actor uuid,p_brief uuid,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.briefs; r public.requests; v public.request_revisions; c public.linear_connections; t public.linear_handoffs; preview jsonb; payload jsonb;
begin
  select * into b from public.briefs where id=p_brief;
  select * into r from public.requests where id=b.request_id for update;
  perform 1 from public.workspaces where id=b.workspace_id for update;
  select * into v from public.request_revisions where request_id=r.id and number=b.revision;
  if not exists(select 1 from public.memberships m where m.workspace_id=b.workspace_id and m.user_id=p_actor and m.status='active'
    and (p_actor=r.author_id or m.role='product_lead' and p_actor=v.product_reviewer_id or m.role='engineering_lead' and p_actor=v.engineering_reviewer_id))
    then raise exception 'FORBIDDEN|Only the author or assigned leads can send this brief to Linear.'; end if;
  select * into t from public.linear_handoffs where brief_id=b.id for update;
  preview:=public.linear_preview_for(p_actor,p_brief);
  if preview->>'payloadHash' is distinct from p_hash then raise exception 'PAYLOAD_CHANGED|Preview this exact brief and destination again.'; end if;
  if t.state='created' then return jsonb_build_object('created',true,'preview',preview); end if;
  perform public.linear_assert_source(p_actor,p_brief);
  select * into c from public.linear_connections where workspace_id=b.workspace_id;
  if c.team_id is distinct from (preview->>'teamId')::uuid or c.organization_id is distinct from (preview->>'organizationId')::uuid then raise exception 'DESTINATION_CHANGED|The Linear destination changed. Ask an administrator to reconcile this handoff.'; end if;
  if t.state='creating' and t.lease_until>now() then raise exception 'HANDOFF_RUNNING|This handoff is still processing. Refresh shortly.'; end if;
  if (select count(*) from public.audit_events where workspace_id=b.workspace_id and actor_id=p_actor and action='linear_handoff_started' and created_at>now()-interval '1 hour')>=10 then raise exception 'RATE_LIMIT|The Linear handoff limit has been reached. Try later.'; end if;
  payload:=preview-'payloadHash'-'state'-'issueUrl'-'issueIdentifier'-'error';
  insert into public.linear_handoffs(workspace_id,brief_id,actor_id,payload,payload_hash,state)
    values(b.workspace_id,b.id,p_actor,payload,p_hash,'creating')
    on conflict(brief_id) do update set state='creating',actor_id=p_actor,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',attempts=public.linear_handoffs.attempts+1,error=null returning * into t;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(b.workspace_id,r.id,p_actor,'linear_handoff_started',b.revision);
  return jsonb_build_object('created',false,'id',t.id,'issueId',t.issue_id,'leaseToken',t.lease_token,'preview',public.linear_preview_for(p_actor,b.id));
end; $$;
create function public.linear_check_outbound(p_id uuid,p_lease uuid,p_actor uuid) returns void language plpgsql stable security definer set search_path='' as $$
declare t public.linear_handoffs; c public.linear_connections;
begin
  select * into t from public.linear_handoffs where id=p_id and actor_id=p_actor;
  if t.id is null or t.state<>'creating' or t.lease_token is distinct from p_lease or t.lease_until<=now() then raise exception 'INVALID_LEASE|Preview and confirm this handoff again.'; end if;
  perform public.linear_assert_source(p_actor,t.brief_id);
  select * into c from public.linear_connections where workspace_id=t.workspace_id;
  if c.team_id is distinct from (t.payload->>'teamId')::uuid or c.organization_id is distinct from (t.payload->>'organizationId')::uuid then raise exception 'DESTINATION_CHANGED|The confirmed destination changed. Preview again.'; end if;
end; $$;
create function public.linear_finish(p_id uuid,p_lease uuid,p_url text,p_identifier text,p_error text) returns void language plpgsql security definer set search_path='' as $$
declare t public.linear_handoffs; b public.briefs;
begin
  select * into t from public.linear_handoffs where id=p_id for update;
  if t.id is null or t.state<>'creating' or t.lease_token is distinct from p_lease then raise exception 'INVALID_LEASE|This handoff was replaced by a newer attempt.'; end if;
  if p_error is null and (p_url is null or p_identifier is null) then raise exception 'INVALID_INPUT|A confirmed issue URL and identifier are required.'; end if;
  update public.linear_handoffs set state=case when p_error is null then 'created' else 'failed' end,
    issue_url=p_url,issue_identifier=p_identifier,error=left(p_error,500) where id=t.id;
  select * into b from public.briefs where id=t.brief_id;
  insert into public.audit_events(workspace_id,request_id,actor_id,action,revision) values(t.workspace_id,b.request_id,t.actor_id,case when p_error is null then 'linear_handoff_created' else 'linear_handoff_failed' end,b.revision);
end; $$;
revoke execute on function public.linear_connection(),public.linear_admin(),public.linear_configure(uuid,uuid,uuid,text,uuid,text,integer),public.linear_preview_for(uuid,uuid),public.linear_preview(uuid),public.linear_claim(uuid,uuid,text),public.linear_finish(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.linear_assert_source(uuid,uuid),public.linear_check_outbound(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.linear_connection(),public.linear_admin(),public.linear_preview(uuid) to authenticated;
grant execute on function public.linear_configure(uuid,uuid,uuid,text,uuid,text,integer),public.linear_claim(uuid,uuid,text),public.linear_finish(uuid,uuid,text,text,text) to service_role;
grant execute on function public.linear_check_outbound(uuid,uuid,uuid) to service_role;
