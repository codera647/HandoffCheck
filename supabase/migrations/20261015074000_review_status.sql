-- Add current review-task metadata without changing workflow states or permissions.
create or replace function public.summary_json(p_row public.requests) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'number',p_row.number,'title',coalesce(nullif(r.fields->>'title',''),'Untitled feature'),'authorId',p_row.author_id,'productReviewerId',coalesce(r.product_reviewer_id::text,''),'engineeringReviewerId',coalesce(r.engineering_reviewer_id::text,''),'status',case when p_row.status='reviewing' and exists(select 1 from public.review_runs where id=p_row.current_review_id and state='running' and expires_at<now()) then 'review_error' else p_row.status end,'currentRevision',p_row.current_revision,'updatedAt',p_row.updated_at,'archived',p_row.archived,
  'reviewTask',(select jsonb_build_object('id',j.id,'reviewId',j.review_id,'state',j.state,'attempts',j.attempts,'nextAttempt',j.next_attempt,'error',j.error) from public.automation_jobs j where j.review_id=p_row.current_review_id and j.request_id=p_row.id and j.workspace_id=p_row.workspace_id and j.kind='review' order by j.created_at desc limit 1),
  'blockingCount',(select count(*) from public.findings f left join public.finding_resolutions x on x.finding_id=f.id where f.review_id=p_row.current_review_id and f.body->>'severity'='blocking' and x.finding_id is null)) from public.request_revisions r where r.request_id=p_row.id and r.number=p_row.current_revision;
$$;
create or replace function public.automation_job_json(j public.automation_jobs) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'reviewId',j.review_id,'requestId',j.request_id,'actorId',j.actor_id,'kind',j.kind,'revision',j.revision,
    'inputHash',j.input_hash,'briefId',j.brief_id,'state',j.state,'output',j.output,'error',j.error,'attempts',j.attempts,
    'createdAt',j.created_at,'accepted',to_jsonb(j.accepted),'reviewedBy',j.reviewed_by,'demo',false,'model',j.model);
$$;
