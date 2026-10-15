import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import type { RequestRecord } from '../../shared/contracts';
import { reminderInputSchema, type ReminderSettings } from '../../shared/reminders';
import { useWorkspace } from '../app/session';
import { ErrorNotice, Loading, Success, formatDate } from '../components/ui';

export function RequestReminders({ record }: { record: RequestRecord }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const { repository, context } = useWorkspace();
  const query = useQuery({
    queryKey: ['request-reminders', repository.mode, context.currentUser.id, record.id],
    queryFn: () => repository.requestReminders(record.id),
    enabled: open,
    retry: false,
    refetchInterval: open ? 60000 : false,
  });
  return (
    <details
      className="sidebar-section request-reminders"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={16} aria-hidden="true" />
        <span>Approval reminder schedule</span>
      </summary>
      {open && (
        <>
          {query.isPending && <Loading label="Loading reminder schedule…" />}
          <ErrorNotice error={query.error} retry={() => void query.refetch()} />
          {query.data && (
            <ReminderForm
              key={`${record.id}:${record.currentRevision}:${query.data.version}`}
              record={record}
              settings={query.data}
              onSaved={() => setSaved(true)}
              onChange={() => setSaved(false)}
            />
          )}
          {saved && <Success>Reminder schedule saved.</Success>}
        </>
      )}
    </details>
  );
}

function ReminderForm({
  record,
  settings,
  onSaved,
  onChange,
}: {
  record: RequestRecord;
  settings: ReminderSettings;
  onSaved(): void;
  onChange(): void;
}) {
  const { repository, context } = useWorkspace();
  const queries = useQueryClient();
  const unit =
    settings.intervalMinutes % 1440 === 0 ? 1440 : settings.intervalMinutes % 60 === 0 ? 60 : 1;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [emailEnabled, setEmailEnabled] = useState(settings.emailEnabled);
  const [amount, setAmount] = useState(String(settings.intervalMinutes / unit));
  const [multiplier, setMultiplier] = useState(unit);
  const author = context.currentUser.id === record.authorId;
  const mutation = useMutation({
    mutationFn: () =>
      repository.saveRequestReminders(
        record.id,
        reminderInputSchema.parse({
          enabled,
          emailEnabled,
          intervalMinutes: Number(amount) * multiplier,
          expectedRevision: record.currentRevision,
          expectedVersion: settings.version,
        }),
      ),
    onSuccess: (value) => {
      onSaved();
      queries.setQueryData(
        ['request-reminders', repository.mode, context.currentUser.id, record.id],
        value,
      );
    },
  });
  const inputValid = reminderInputSchema.safeParse({
    enabled,
    emailEnabled,
    intervalMinutes: Number(amount) * multiplier,
    expectedRevision: record.currentRevision,
    expectedVersion: settings.version,
  }).success;
  const change = onChange;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onChange();
        mutation.mutate();
      }}
      aria-label="Approval reminder settings"
    >
      <p className="small">
        Reminders go only to assigned leads who have not approved. The author controls the repeat
        interval.
      </p>
      {settings.demo && (
        <p className="notice neutral small">Automatic timers are unavailable in this local demo.</p>
      )}
      {!settings.demo && !settings.schedulerConfigured && (
        <p className="notice neutral small">
          The private scheduler is not configured. You can pause a schedule; ask the administrator
          before enabling it.
        </p>
      )}
      <fieldset disabled={!author || settings.demo || mutation.isPending}>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!settings.schedulerConfigured && !enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
              change();
            }}
          />{' '}
          Repeat reminders
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(event) => {
              setEmailEnabled(event.target.checked);
              change();
            }}
          />{' '}
          Email reviewers too
        </label>
        <label htmlFor="reminder-amount">Repeat every</label>
        <div className="reminder-duration">
          <input
            id="reminder-amount"
            type="number"
            min={1}
            max={10080}
            step={1}
            value={amount}
            required
            onChange={(event) => {
              setAmount(event.target.value);
              change();
            }}
          />
          <select
            aria-label="Reminder time unit"
            value={multiplier}
            onChange={(event) => {
              setMultiplier(Number(event.target.value));
              change();
            }}
          >
            <option value={1}>Minutes</option>
            <option value={60}>Hours</option>
            <option value={1440}>Days</option>
          </select>
        </div>
        <p className="field-help">
          Choose 15 minutes to 7 days. The timer starts when this revision is ready for approval.
        </p>
        {author && (
          <button
            className="button small-button"
            disabled={!inputValid || (enabled && !settings.schedulerConfigured)}
          >
            {mutation.isPending ? 'Saving…' : 'Save reminder schedule'}
          </button>
        )}
      </fieldset>
      {!author && <p className="small">Only the request author can change this schedule.</p>}
      {emailEnabled && !settings.demo && !settings.emailConfigured && (
        <p className="notice neutral small">
          Email setup is pending. You can enable in-app reminders now; selected emails wait for
          Resend configuration.
        </p>
      )}
      {settings.custom && (
        <p className="small" role="status">
          {settings.state === 'scheduled'
            ? 'Repeating while approvals are pending.'
            : settings.state === 'waiting'
              ? 'Waiting until this revision is ready for approval.'
              : settings.state === 'stopped'
                ? 'Stopped: this request is approved or archived. A new approval round starts a fresh timer.'
                : 'Repeat reminders are paused.'}
        </p>
      )}
      {settings.nextDueAt && (
        <p className="small">
          Next reminder:{' '}
          <strong>{formatDate(settings.nextDueAt, context.workspace.timezone)}</strong>. Delivery
          happens on the next scheduler scan, usually within a minute.
        </p>
      )}
      {settings.lastSentAt && (
        <p className="small">
          Last reminder: {formatDate(settings.lastSentAt, context.workspace.timezone)}
        </p>
      )}
      {!settings.custom && (
        <p className="small">
          No repeat schedule is saved. The workspace may still send its default one-time reminder.
          Saving a paused schedule disables that default for this request.
        </p>
      )}
      {settings.emailEnabled && settings.custom && settings.emailConfigured && (
        <p className="small">
          Email:{' '}
          {settings.emailStatus === 'sent'
            ? 'accepted by Resend; inbox delivery is not confirmed'
            : settings.emailStatus === 'failed'
              ? 'the latest attempt failed; the next reminder cycle will try again'
              : settings.emailStatus === 'sending'
                ? 'sending the latest reminder'
                : settings.emailStatus === 'queued'
                  ? 'queued for sending'
                  : settings.emailStatus === 'off'
                    ? 'paused'
                    : 'waiting for the next reminder cycle'}
          .
        </p>
      )}
      {settings.lastEmailSentAt && (
        <p className="small">
          Last email accepted: {formatDate(settings.lastEmailSentAt, context.workspace.timezone)}
        </p>
      )}
      <ErrorNotice
        error={mutation.error}
        retry={() => void queries.invalidateQueries({ queryKey: ['request-reminders'] })}
      />
    </form>
  );
}
