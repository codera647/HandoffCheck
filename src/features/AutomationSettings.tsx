import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { ErrorNotice, Loading, Success } from '../components/ui';
import type { AutomationPolicy, PolicyInput } from '../../shared/automation';

export function AutomationSettings() {
  const { repository, context } = useWorkspace();
  const [saved, setSaved] = useState('');
  const query = useQuery({
    queryKey: ['automation-policy', repository.mode, context.workspace.id],
    queryFn: () => repository.automationPolicy(),
  });
  if (query.isPending) return <Loading />;
  if (query.error || !query.data)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      {saved && <Success>{saved}</Success>}
      <PolicyForm
        key={query.data.version}
        policy={query.data}
        onSaved={() => setSaved('Automation settings saved.')}
      />
    </>
  );
}
function PolicyForm({ policy, onSaved }: { policy: AutomationPolicy; onSaved: () => void }) {
  const { repository } = useWorkspace(),
    queries = useQueryClient();
  const [input, setInput] = useState<PolicyInput>({
    aiEnabled: policy.aiEnabled,
    suggestions: policy.suggestions,
    summaries: policy.summaries,
    qa: policy.qa,
    background: policy.background,
    autoBrief: policy.autoBrief,
    reminders: policy.reminders,
    reminderHours: policy.reminderHours,
    dailyLimit: policy.dailyLimit,
    expectedVersion: policy.version,
  });
  const [message, setMessage] = useState('');
  const mutation = useMutation({
    mutationFn: async (test: boolean) => {
      if (test) {
        const result = await repository.testAIProvider();
        setMessage(
          result.verified
            ? `Synthetic provider check passed with ${result.model}.`
            : 'Provider check did not pass.',
        );
      } else {
        await repository.saveAutomationPolicy(input);
        await queries.invalidateQueries({ queryKey: ['automation-policy'] });
        await queries.invalidateQueries({ queryKey: ['context'] });
        onSaved();
      }
    },
  });
  const toggle = (
    key: keyof Pick<
      PolicyInput,
      'aiEnabled' | 'suggestions' | 'summaries' | 'qa' | 'background' | 'autoBrief' | 'reminders'
    >,
    label: string,
    detail: string,
    disabled = false,
  ) => (
    <label className="automation-option" key={key}>
      <input
        type="checkbox"
        checked={input[key]}
        disabled={disabled || mutation.isPending}
        onChange={(e) => setInput({ ...input, [key]: e.target.checked })}
      />
      <span>
        <strong>{label}</strong>
        <span className="field-help">{detail}</span>
      </span>
    </label>
  );
  return (
    <section className="settings-section">
      <h2>Automation</h2>
      <p className="section-intro">
        Authors accept requirement edits. Both assigned leads approve the same revision.
      </p>
      <p className="notice">
        {policy.demo
          ? 'Local demo: assistance uses deterministic fixtures. No AI provider is contacted.'
          : policy.providerConfigured
            ? 'Gemini credentials are configured. Run the synthetic provider check before enabling AI.'
            : 'Gemini setup is pending. An operator must save the API key and model in backend secrets.'}
      </p>
      <ErrorNotice error={mutation.error} />
      {message && <Success>{message}</Success>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setMessage('');
          mutation.mutate(false);
        }}
      >
        {toggle(
          'aiEnabled',
          policy.demo ? 'Enable simulated assistance' : 'Enable AI review',
          'Request text is sent to Gemini. Use synthetic requirements for this pilot.',
          !policy.providerConfigured,
        )}
        {toggle(
          'suggestions',
          'Suggested requirement edits',
          'The author reviews each field comparison before saving a new revision.',
        )}
        {toggle(
          'summaries',
          'Reviewer summaries',
          'Short summaries quote the source requirements and do not provide approval.',
        )}
        {toggle(
          'qa',
          'QA drafts',
          'Generate proposed tests from an approved brief; the assigned engineering lead marks them reviewed.',
        )}
        {toggle(
          'background',
          'Background processing',
          'Queued work continues through the private scheduler when the app is closed.',
          !policy.schedulerConfigured,
        )}
        {toggle(
          'autoBrief',
          'Generate brief after both approvals',
          'The second valid approval creates the same deterministic brief as the manual action.',
        )}
        {toggle(
          'reminders',
          'Default one-time review reminder',
          'Notify each pending lead once per revision unless the author saves a request-specific schedule. No email is sent.',
          !policy.schedulerConfigured,
        )}
        <div className="automation-limits">
          <label>
            Daily AI attempt limit
            <input
              type="number"
              min={1}
              max={50}
              value={input.dailyLimit}
              onChange={(e) => setInput({ ...input, dailyLimit: Number(e.target.value) })}
              required
            />
          </label>
          <label>
            Remind after hours
            <input
              type="number"
              min={1}
              max={168}
              value={input.reminderHours}
              onChange={(e) => setInput({ ...input, reminderHours: Number(e.target.value) })}
              required
            />
          </label>
        </div>
        <p className="small">
          Limits cover provider attempts, including retries. They do not guarantee an exact provider
          bill.
        </p>
        <div className="header-actions">
          <button className="button primary" disabled={mutation.isPending}>
            Save automation settings
          </button>
          {!policy.demo && (
            <button
              type="button"
              className="button"
              disabled={!policy.providerConfigured || mutation.isPending}
              onClick={() => {
                setMessage('');
                mutation.mutate(true);
              }}
            >
              Test Gemini with synthetic text
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
