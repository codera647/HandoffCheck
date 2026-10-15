import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { currentRevision, canReview } from '../../shared/domain';
import { fieldLabels, type RequestRecord, type Brief } from '../../shared/contracts';
import { fieldText, type AutomationTask, type TaskKind } from '../../shared/automation';
import { ConfirmDialog, ErrorNotice, Loading, Success } from '../components/ui';

const labels = {
  queued: 'Queued',
  working: 'Working',
  ready: 'Ready to review',
  failed: 'Failed',
  outdated: 'Outdated',
  cancelled: 'Cancelled',
};
export function AssistancePanel({ record, brief }: { record: RequestRecord; brief?: Brief }) {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient(),
    rev = currentRevision(record);
  const source = brief ? record.revisions.find((r) => r.number === brief.revision)! : rev;
  const policy = useQuery({
    queryKey: ['automation-policy', repository.mode, context.workspace.id],
    queryFn: () => repository.automationPolicy(),
  });
  const tasks = useQuery({
    queryKey: ['assistance', repository.mode, context.currentUser.id, record.id],
    queryFn: () => repository.assistance(record.id),
    refetchInterval: (q) =>
      q.state.data?.some((t) => ['queued', 'working'].includes(t.state)) ? 3000 : false,
  });
  const [edit, setEdit] = useState<{ task: AutomationTask; index: number } | null>(null),
    [message, setMessage] = useState('');
  const refresh = async () => {
    await queries.invalidateQueries({ queryKey: ['assistance'] });
    await queries.invalidateQueries({ queryKey: ['request'] });
    await queries.invalidateQueries({ queryKey: ['requests'] });
  };
  const work = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: refresh,
  });
  const request = (kind: TaskKind) => {
    setMessage('');
    work.mutate(() =>
      repository.requestAssistance(record.id, kind, source.number, brief?.id ?? null),
    );
  };
  const permitted = !record.archived && (brief || canReview(record, context.currentUser));
  const ready = policy.data?.aiEnabled && policy.data.providerConfigured;
  const selectedEdit =
    edit?.task.output && 'edits' in edit.task.output ? edit.task.output.edits[edit.index] : null;
  return (
    <section
      className="assistance-section"
      aria-label={brief ? 'QA assistance' : 'Requirement assistance'}
    >
      <h2>{brief ? 'QA draft' : 'Requirement assistance'}</h2>
      <p className="small">
        {repository.mode === 'demo'
          ? 'Simulated assistance uses local fixtures; no AI is called.'
          : 'AI output is a proposal. Check its source before accepting it.'}
      </p>
      {!brief && (
        <p className="small">
          These results are shared with the workspace. Summaries and suggested edits support the
          review; approval requires a successful requirement review and both assigned leads.
        </p>
      )}
      <ErrorNotice error={policy.error || tasks.error || work.error} />
      {message && <Success>{message}</Success>}
      {policy.isPending ? (
        <Loading />
      ) : (
        !ready && (
          <p className="notice">
            {repository.mode === 'demo'
              ? 'An administrator can enable simulated assistance in Settings → Automation.'
              : 'AI assistance is disabled or waiting for Gemini configuration.'}
          </p>
        )
      )}
      <div className="header-actions">
        {brief ? (
          <button
            className="button"
            disabled={!ready || !policy.data?.qa || !permitted || work.isPending}
            onClick={() => request('qa')}
          >
            Draft QA checklist
          </button>
        ) : (
          <>
            <button
              className="button"
              disabled={!ready || !policy.data?.suggestions || !permitted || work.isPending}
              onClick={() => request('edits')}
            >
              Suggest requirement edits
            </button>
            <button
              className="button"
              disabled={!ready || !policy.data?.summaries || !permitted || work.isPending}
              onClick={() => request('summary')}
            >
              Prepare reviewer summary
            </button>
          </>
        )}
      </div>
      {tasks.isPending && <Loading />}
      {tasks.data
        ?.filter((t) => (brief ? t.briefId === brief.id : t.kind !== 'qa'))
        .map((task) => {
          const taskSource = record.revisions.find((r) => r.number === task.revision) ?? source;
          const outdated = task.kind !== 'qa' && task.revision !== record.currentRevision;
          return (
            <article className="assistance-result" key={task.id}>
              <div className="assistance-heading">
                <h3>
                  {task.kind === 'edits'
                    ? 'Suggested edits'
                    : task.kind === 'summary'
                      ? 'Reviewer summary'
                      : task.kind === 'qa'
                        ? 'QA checklist draft'
                        : 'AI requirement review'}
                </h3>
                <span className="badge neutral">
                  {task.accepted.length
                    ? 'Edit accepted'
                    : outdated
                      ? 'Outdated'
                      : labels[task.state]}
                </span>
              </div>
              <p className="small">
                Revision {task.revision}
                {task.demo ? ' · simulated fixture' : task.model ? ` · ${task.model}` : ''}
              </p>
              {task.error && <ErrorNotice error={new Error(task.error)} />}
              {task.state === 'failed' && task.kind !== 'review' && (
                <button
                  className="button"
                  disabled={!ready || work.isPending || outdated}
                  onClick={() => request(task.kind as TaskKind)}
                >
                  Try again
                </button>
              )}
              {task.output &&
                'edits' in task.output &&
                task.output.edits.map((item, index) => (
                  <div className="suggestion" key={index}>
                    <h4>{fieldLabels[item.field]}</h4>
                    <p>{item.reason}</p>
                    <blockquote>{item.evidenceQuote}</blockquote>
                    <p className="small">Source: {fieldLabels[item.evidenceField]}</p>
                    <div className="suggestion-comparison">
                      <div>
                        <strong>Source text</strong>
                        <p>{fieldText(taskSource.fields, item.field) || 'No value recorded'}</p>
                      </div>
                      <div>
                        <strong>Proposed text</strong>
                        <p>{item.text}</p>
                      </div>
                    </div>
                    {context.currentUser.id === record.authorId && (
                      <button
                        className="button"
                        disabled={
                          task.state !== 'ready' || outdated || work.isPending || record.archived
                        }
                        onClick={() => setEdit({ task, index })}
                      >
                        Review and accept edit
                      </button>
                    )}
                  </div>
                ))}
              {task.output && 'edits' in task.output && !task.output.edits.length && (
                <p>No requirement edits were suggested.</p>
              )}
              {task.output && 'items' in task.output && (
                <ul>
                  {task.output.items.map((item, index) => (
                    <li key={index}>
                      <p>{item.text}</p>
                      <blockquote>{item.evidenceQuote}</blockquote>
                      <span className="small">Source: {fieldLabels[item.evidenceField]}</span>
                    </li>
                  ))}
                </ul>
              )}
              {task.output && 'tests' in task.output && (
                <>
                  <ol>
                    {task.output.tests.map((test, index) => (
                      <li key={index}>
                        <strong>{test.scenario}</strong>
                        <p className="small">
                          {test.kind} · Acceptance criterion {test.criterionIndex + 1}
                        </p>
                        <blockquote>{test.criterionQuote}</blockquote>
                        <ul>
                          {test.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ul>
                        <p>Expected: {test.expected}</p>
                      </li>
                    ))}
                  </ol>
                  <p className="small">These tests have not been executed.</p>
                  {task.reviewedBy ? (
                    <p className="success-message">
                      Reviewed by{' '}
                      {context.members.find((m) => m.id === task.reviewedBy)?.name ||
                        'the assigned engineering lead'}
                      .
                    </p>
                  ) : (
                    context.currentUser.role === 'engineering_lead' &&
                    source.engineeringReviewerId === context.currentUser.id && (
                      <button
                        className="button"
                        disabled={work.isPending || task.state !== 'ready'}
                        onClick={() => work.mutate(() => repository.reviewQA(task.id))}
                      >
                        Mark QA draft reviewed
                      </button>
                    )
                  )}
                  <button
                    className="button"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(JSON.stringify(task.output, null, 2))
                        .then(() => setMessage('QA draft copied.'))
                        .catch(() =>
                          setMessage(
                            'Copy failed. Select the displayed draft text to copy it manually.',
                          ),
                        );
                    }}
                  >
                    Copy QA draft
                  </button>
                </>
              )}
            </article>
          );
        })}
      <ConfirmDialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) setEdit(null);
        }}
        title="Accept suggested requirement edit"
        description={`This saves a new revision based on revision ${edit?.task.revision}. The current approvals will not apply to the changed revision.`}
      >
        {selectedEdit && (
          <>
            <h3>{fieldLabels[selectedEdit.field]}</h3>
            <p className="suggested-text">{selectedEdit.text}</p>
          </>
        )}
        <ErrorNotice error={work.error} />
        <div className="dialog-actions">
          <button className="button" onClick={() => setEdit(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={work.isPending}
            onClick={async () => {
              if (!edit) return;
              try {
                await work.mutateAsync(() =>
                  repository.acceptEdit(edit.task.id, edit.index, edit.task.revision),
                );
                setEdit(null);
                setMessage(
                  'Suggested edit saved as a new revision. Review the changed requirements again.',
                );
              } catch {
                /* Visible mutation error. */
              }
            }}
          >
            Accept edit and save revision
          </button>
        </div>
      </ConfirmDialog>
    </section>
  );
}
