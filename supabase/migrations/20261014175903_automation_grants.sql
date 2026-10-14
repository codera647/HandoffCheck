-- Supabase's default table privileges include TRUNCATE, which bypasses row policies.
-- Keep only the two intended client read surfaces; all writes go through narrow RPCs.
revoke all on public.automation_policies,public.automation_jobs,public.ai_usage,
  public.in_app_notifications,public.automation_nonces,public.linear_connections,public.linear_handoffs
  from public,anon,authenticated;
grant select on public.automation_policies,public.in_app_notifications to authenticated;
