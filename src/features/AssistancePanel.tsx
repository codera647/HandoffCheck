import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  Clock,
  Copy,
  FileText,
  MessageSquare,
  Pencil,
  RotateCw,
} from 'lucide-react';
import { useWorkspace } from '../app/session';
import {
  blockingFindings,
  canStartReview,
  currentReview,
  currentRevision,
  canReview,
  reviewStatusLabel,
} from '../../shared/domain';
import {
  fieldLabels,
  type FieldName,
  type RequestRecord,
  type Brief,
} from '../../shared/contracts';
import { fieldText, type AutomationTask, type TaskKind } from '../../shared/automation';
import { ConfirmDialog, ErrorNotice, Loading, Success, formatDate } from '../components/ui';
import {
  AssistanceResponse,
  assistanceText,
  ReviewResponse,
  reviewResponseText,
} from './AssistanceResponse';
import { assistantActivities, reviewForActivity } from './assistant-activity';
import {
  activitySignature,
  activityVisibilityId,
  isActivityHidden,
  readChatVisibility,
  saveChatVisibility,
} from '../lib/assistant-history';

const titles = {
  review: 'AI requirement review',
  edits: 'Suggested edits',
  summary: 'Reviewer summary',
  qa: 'QA checklist draft',
};
const requests = {
  review: 'Check the requirements for missing details and blocking questions.',
  edits: 'Suggest clearer wording for these requirements.',
  summary: 'Prepare a summary for the assigned reviewers.',
  qa: 'Draft QA checks from the approved acceptance criteria.',
};
const labels = {
  queued: 'Queued',
  working: 'Working',
  ready: 'Response ready',
  failed: 'Failed',
  outdated: 'Outdated',
  cancelled: 'Cancelled',
};

export function AssistancePanel({ record, brief }: { record: RequestRecord; brief?: Brief }) {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient(),
    rev = currentRevision(record);
  const source = brief ? record.revisions.find((r) => r.number === brief.revision)! : rev;
  const review = currentReview(record);
  const blockingQuestionCount = blockingFindings(review).length;
  const thread = useRef<HTMLDivElement>(null);
  const sourceText = useRef<HTMLDivElement>(null);
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
  const [edit, setEdit] = useState<{ task: AutomationTask; index: number } | null>(null);
  const [message, setMessage] = useState('');
  const [copyError, setCopyError] = useState<unknown>(null);
  const historyKey = `handoffcheck:assistant:${context.workspace.id}:${context.currentUser.id}:${record.id}:${brief?.id ?? 'requirements'}`;
  const [history, setHistory] = useState(() => readChatVisibility(historyKey));
  const [clearDialog, setClearDialog] = useState(false);
  const [filter, setFilter] = useState<'all' | 'current'>('all');
  const [inspected, setInspected] = useState<{ field: FieldName; revision: number } | null>(null);
  const refresh = async () => {
    await Promise.all([
      queries.invalidateQueries({ queryKey: ['assistance'] }),
      queries.invalidateQueries({ queryKey: ['request'] }),
      queries.invalidateQueries({ queryKey: ['requests'] }),
    ]);
  };
  const work = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: refresh,
  });
  const request = (kind: TaskKind) => {
    setMessage('');
    work.mutate(async () => {
      const task = tasks.data?.find(
        (task) =>
          task.kind === kind &&
          task.revision === source.number &&
          task.briefId === (brief?.id ?? null) &&
          ['queued', 'working', 'ready'].includes(task.state),
      );
      await repository.requestAssistance(record.id, kind, source.number, brief?.id ?? null);
      if (task && history.hidden.has(task.id)) {
        const hidden = new Map(history.hidden);
        hidden.delete(task.id);
        try {
          setHistory(saveChatVisibility(historyKey, hidden));
        } catch (error) {
          setHistory((previous) => ({
            ...previous,
            error:
              error instanceof Error
                ? error
                : new Error('The saved response could not be revealed.'),
          }));
        }
      }
      if (task?.state === 'ready') setMessage('Showing the saved response for this revision.');
    });
  };
  const runReview = () => {
    setMessage('');
    work.mutate(() =>
      repository.command(
        record.id,
        { action: 'review', expectedRevision: source.number },
        crypto.randomUUID(),
      ),
    );
  };
  const permitted = !record.archived && (!!brief || canReview(record, context.currentUser));
  const ready = policy.data?.aiEnabled && policy.data.providerConfigured;
  const scopedTasks = assistantActivities(
    record,
    tasks.data ?? [],
    repository.mode === 'demo',
  ).filter((t) => (brief ? t.briefId === brief.id : t.kind !== 'qa'));
  const visibleTasks = scopedTasks
    .filter((task) => !isActivityHidden(task, history.hidden))
    .filter((t) => filter === 'all' || t.revision === source.number);
  const pendingTasks = scopedTasks.filter((t) => ['queued', 'working'].includes(t.state));
  const waitingRetry = pendingTasks.some((t) => t.state === 'queued' && t.attempts > 0);
  const active = work.isPending || pendingTasks.length > 0;
  const inspectedRevision =
    record.revisions.find((r) => r.number === inspected?.revision) ?? source;
  const inspectedField = inspected?.field ?? 'behavior';
  const selectedEdit =
    edit?.task.output && 'edits' in edit.task.output ? edit.task.output.edits[edit.index] : null;
  useEffect(() => {
    const container = thread.current;
    if (container) container.scrollTop = 0;
  }, [visibleTasks.length, visibleTasks[0]?.id, filter]);
  const currentJob = tasks.data?.find((task) => task.id === record.reviewTask?.id);
  useEffect(() => {
    if (
      record.status === 'reviewing' &&
      currentJob &&
      ['ready', 'failed', 'cancelled', 'outdated'].includes(currentJob.state)
    ) {
      void queries.invalidateQueries({ queryKey: ['request'] });
      void queries.invalidateQueries({ queryKey: ['requests'] });
    }
  }, [queries, record.status, currentJob?.id, currentJob?.state]);
  const copy = async (task: AutomationTask) => {
    setCopyError(null);
    try {
      const savedReview = reviewForActivity(record, task);
      await navigator.clipboard.writeText(
        task.kind === 'review' && savedReview
          ? reviewResponseText(savedReview)
          : assistanceText(task),
      );
      setMessage(task.kind === 'qa' ? 'QA draft copied.' : 'Response copied.');
    } catch {
      setCopyError(new Error('Copy failed. Select the response text to copy it manually.'));
    }
  };
  const viewSource = (field: FieldName, revision: number) => {
    setInspected({ field, revision });
    requestAnimationFrame(() => sourceText.current?.focus());
  };
  const changeHistory = (clear: boolean) => {
    try {
      const hidden = clear
        ? new Map([
            ...history.hidden,
            ...scopedTasks.map(
              (task) => [activityVisibilityId(task), activitySignature(task)] as [string, string],
            ),
          ])
        : new Map<string, string>();
      setHistory(saveChatVisibility(historyKey, hidden));
      setClearDialog(false);
      setMessage(
        clear
          ? 'Chat cleared for you on this device. You can restore messages.'
          : 'Messages restored.',
      );
    } catch (error) {
      setHistory((previous) => ({
        ...previous,
        error: error instanceof Error ? error : new Error('The chat view could not be saved.'),
      }));
    }
  };
  return (
    <section
      className="assistance-section"
      id={brief ? 'qa-assistant' : 'requirement-assistant'}
      aria-label={brief ? 'QA assistance' : 'Requirement assistance'}
    >
      <div className="assistant-header">
        <div className="assistant-heading">
          <span className="assistant-avatar">
            <MessageSquare size={19} />
          </span>
          <div>
            <h2>{brief ? 'QA assistant' : 'Requirement assistant'}</h2>
            <p className="small">
              {brief ? 'Work from the approved brief' : 'Review and refine the saved requirements'}
            </p>
          </div>
        </div>
        <span className="assistant-state" role="status">
          {waitingRetry ? (
            <Clock size={14} />
          ) : active ? (
            <RotateCw size={14} />
          ) : (
            <MessageSquare size={14} />
          )}
          {waitingRetry ? 'Waiting to retry' : active ? 'Task in progress' : 'Choose a task'}
        </span>
      </div>
      <div className="assistant-workspace">
        <div className="assistant-conversation">
          <div className="assistant-toolbar">
            <span className="small">
              {visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'} shown · Newest
              first
            </span>
            <div className="assistant-filters" aria-label="Activity filter">
              <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All revisions
              </button>
              <button
                disabled={
                  work.isPending ||
                  !scopedTasks.some((task) => !isActivityHidden(task, history.hidden))
                }
                onClick={() => setClearDialog(true)}
              >
                Clear chat
              </button>
              {history.hidden.size > 0 && (
                <button disabled={work.isPending} onClick={() => changeHistory(false)}>
                  Restore messages
                </button>
              )}
              <button aria-pressed={filter === 'current'} onClick={() => setFilter('current')}>
                Revision {source.number}
              </button>
            </div>
          </div>
          <ErrorNotice
            error={policy.error || tasks.error || work.error || copyError || history.error}
          />
          {message && <Success>{message}</Success>}
          {pendingTasks.length > 0 && (
            <section className="assistant-active-tasks" aria-label="Running assistant tasks">
              <h3>In progress</h3>
              <ul>
                {pendingTasks.map((task) => (
                  <li key={task.id}>
                    <strong>
                      {titles[task.kind]} · Revision {task.revision}
                    </strong>
                    <span>
                      {task.state === 'queued'
                        ? task.attempts > 0
                          ? `Retry pending · attempt ${task.attempts} failed`
                          : 'Queued'
                        : `Running${task.attempts > 0 ? ` · attempt ${task.attempts} of 3` : ''}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div
            className="assistant-thread"
            ref={thread}
            role="log"
            aria-label="Assistant activity"
            tabIndex={0}
          >
            {tasks.isPending ? (
              <Loading label="Loading assistant activity…" />
            ) : visibleTasks.length === 0 ? (
              <div className="assistant-empty">
                <MessageSquare size={24} />
                <h3>{history.hidden.size ? 'Chat cleared' : 'Start with a focused task'}</h3>
                <p>
                  {brief
                    ? 'Turn the approved acceptance criteria into a QA draft, then check every test against its source.'
                    : 'Check the requirements, compare wording suggestions, or prepare a summary for the leads.'}
                </p>
                <p className="small">Choose an action below. Results stay with this request.</p>
              </div>
            ) : (
              visibleTasks.map((task) => {
                const taskSource = record.revisions.find((r) => r.number === task.revision);
                const savedReview = reviewForActivity(record, task);
                const previousReview =
                  task.kind === 'review' &&
                  Boolean(
                    task.reviewId
                      ? task.reviewId !== record.currentReviewId
                      : record.reviewTask && task.id !== record.reviewTask.id,
                  );
                const outdated =
                  previousReview ||
                  task.state === 'outdated' ||
                  task.revision !== source.number ||
                  !taskSource ||
                  task.inputHash !== taskSource.inputHash;
                const retrying = task.state === 'queued' && task.attempts > 0;
                return (
                  <article className="assistant-turn" key={task.id}>
                    <div className="assistant-user-message">
                      <span className="small">
                        {task.origin === 'review'
                          ? 'Saved review'
                          : context.members.find((m) => m.id === task.actorId)?.name ||
                            'Workspace member'}{' '}
                        · Revision {task.revision}
                      </span>
                      <p>{requests[task.kind]}</p>
                    </div>
                    <div className="assistant-reply">
                      <div className="assistant-reply-marker">
                        <MessageSquare size={15} />
                      </div>
                      <div className="assistant-reply-content">
                        <div className="assistance-heading">
                          <h3>
                            {savedReview?.mode === 'checklist_only'
                              ? 'Checklist review'
                              : titles[task.kind]}
                          </h3>
                          <span
                            className={`badge ${task.state === 'failed' ? 'attention' : 'neutral'}`}
                          >
                            {task.accepted.length
                              ? 'Edit accepted'
                              : previousReview
                                ? 'Previous review'
                                : outdated
                                  ? 'Outdated'
                                  : retrying
                                    ? 'Waiting to retry'
                                    : labels[task.state]}
                          </span>
                        </div>
                        {task.kind === 'review' &&
                          !previousReview &&
                          savedReview?.id === record.currentReviewId && (
                            <p className="small">
                              Current requirement review · Revision {task.revision}
                            </p>
                          )}
                        <p className="small">
                          {formatDate(task.createdAt, context.workspace.timezone)}
                          {task.demo
                            ? ' · simulated fixture'
                            : task.model
                              ? ` · ${task.model}`
                              : ''}
                          {task.attempts > 0 && !task.demo
                            ? ` · Attempt ${task.attempts} of 3`
                            : ''}
                        </p>
                        {retrying ? (
                          <p className="notice neutral">
                            The last attempt could not finish. A retry is queued with a delay; each
                            attempt counts toward the workspace budget.
                            {task.error && (
                              <span className="assistant-error-detail">{task.error}</span>
                            )}
                          </p>
                        ) : (
                          task.error &&
                          (previousReview ? (
                            <details className="assistant-evidence">
                              <summary>Previous review error</summary>
                              <ErrorNotice error={new Error(task.error)} />
                            </details>
                          ) : (
                            <ErrorNotice error={new Error(task.error)} />
                          ))
                        )}
                        {task.state === 'queued' && !retrying && (
                          <p className="small">
                            Waiting for a worker. Your saved requirements are unchanged.
                          </p>
                        )}
                        {task.state === 'working' && (
                          <p className="small" role="status">
                            Gemini is processing the saved requirement text…
                          </p>
                        )}
                        {outdated && (
                          <p className="small">
                            Historical result. Use the current revision for new changes and
                            approvals.
                          </p>
                        )}
                        {task.output && taskSource && (
                          <details className="assistant-response-details" open={!outdated}>
                            <summary>{outdated ? 'Read previous response' : 'Response'}</summary>
                            <AssistanceResponse
                              task={task}
                              fields={taskSource.fields}
                              outdated={outdated}
                              author={
                                context.currentUser.id === record.authorId && !record.archived
                              }
                              pending={work.isPending}
                              qaReviewer={
                                !record.archived &&
                                context.currentUser.role === 'engineering_lead' &&
                                taskSource.engineeringReviewerId === context.currentUser.id
                              }
                              reviewerName={
                                context.members.find((m) => m.id === task.reviewedBy)?.name ||
                                'the assigned engineering lead'
                              }
                              accept={(index) => setEdit({ task, index })}
                              reviewQA={() => work.mutate(() => repository.reviewQA(task.id))}
                              viewSource={(field) => viewSource(field, task.revision)}
                            />
                          </details>
                        )}
                        {task.kind === 'review' &&
                          savedReview &&
                          (savedReview.state === 'succeeded' ||
                            savedReview.findings.length > 0) && (
                            <details className="assistant-response-details" open={!outdated}>
                              <summary>
                                {outdated ? 'Read previous response' : 'Review response'}
                              </summary>
                              <ReviewResponse
                                review={savedReview}
                                viewSource={(field) => viewSource(field, task.revision)}
                              />
                            </details>
                          )}
                        {task.kind === 'review' && task.state === 'failed' && !previousReview && (
                          <p className="small">
                            No review response was produced. Approval remains blocked.
                          </p>
                        )}
                        {task.kind === 'review' && (
                          <Link
                            className="assistant-result-link"
                            to={`/requests/${record.id}?tab=review`}
                          >
                            Open current review <ArrowRight size={14} />
                          </Link>
                        )}
                        <div className="assistant-response-actions">
                          {(task.output ||
                            savedReview?.state === 'succeeded' ||
                            Boolean(savedReview?.findings.length)) && (
                            <button className="text-button" onClick={() => void copy(task)}>
                              <Copy size={13} />
                              {task.kind === 'qa' ? 'Copy QA draft' : 'Copy response'}
                            </button>
                          )}
                          {task.state === 'failed' &&
                            !outdated &&
                            (task.kind === 'review' ? (
                              <button
                                className="text-button"
                                disabled={
                                  !canStartReview(record, context.currentUser) || work.isPending
                                }
                                onClick={runReview}
                              >
                                <RotateCw size={13} />
                                Retry requirement review
                              </button>
                            ) : (
                              <button
                                className="text-button"
                                disabled={
                                  !ready ||
                                  !permitted ||
                                  work.isPending ||
                                  !policy.data?.[
                                    task.kind === 'edits'
                                      ? 'suggestions'
                                      : task.kind === 'summary'
                                        ? 'summaries'
                                        : 'qa'
                                  ]
                                }
                                onClick={() => request(task.kind as TaskKind)}
                              >
                                <RotateCw size={13} />
                                Try again
                              </button>
                            ))}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
          <div className="assistant-composer">
            <strong>Choose a task</strong>
            <p className="small">
              Uses saved revision {source.number}. Attachments and linked pages are not read.
            </p>
            {policy.isPending ? (
              <Loading />
            ) : (
              !ready && (
                <p className="small">
                  {repository.mode === 'demo'
                    ? 'An administrator can enable simulated assistance in Settings → Automation.'
                    : 'AI tasks are disabled or waiting for Gemini configuration.'}
                </p>
              )
            )}
            {!permitted && (
              <p className="small">The author and assigned leads can run requirement tasks.</p>
            )}
            <div className="assistant-task-actions">
              {brief ? (
                <button
                  className="button primary"
                  disabled={!ready || !policy.data?.qa || !permitted || work.isPending}
                  onClick={() => request('qa')}
                >
                  <Check size={15} />
                  Draft QA checklist
                </button>
              ) : (
                <>
                  <button
                    className="button"
                    disabled={!canStartReview(record, context.currentUser) || work.isPending}
                    onClick={runReview}
                  >
                    <RotateCw size={15} />
                    Run requirement review
                  </button>
                  <button
                    className="button"
                    disabled={!ready || !policy.data?.suggestions || !permitted || work.isPending}
                    onClick={() => request('edits')}
                  >
                    <Pencil size={15} />
                    Suggest requirement edits
                  </button>
                  <button
                    className="button"
                    disabled={!ready || !policy.data?.summaries || !permitted || work.isPending}
                    onClick={() => request('summary')}
                  >
                    <FileText size={15} />
                    Prepare reviewer summary
                  </button>
                </>
              )}
            </div>
            {work.isPending && (
              <p className="small" role="status">
                Submitting task…
              </p>
            )}
          </div>
        </div>
        <aside className="assistant-context" aria-label="Assistant context">
          <h3>Working context</h3>
          <p className="small">
            {record.title}
            <br />
            Revision {source.number}
            {brief ? ' · Approved brief' : ''}
          </p>
          {!brief && (
            <>
              <h4>Requirement review</h4>
              <p>
                {!review
                  ? 'Not reviewed'
                  : review.state === 'error'
                    ? 'Failed · approval blocked'
                    : review.state === 'running'
                      ? `${reviewStatusLabel(record.status, record.reviewTask)} · approval pending`
                      : review.state === 'succeeded'
                        ? `${blockingQuestionCount} blocking ${blockingQuestionCount === 1 ? 'question' : 'questions'}`
                        : 'A new review is needed'}
              </p>
              <Link to={`/requests/${record.id}?tab=review`}>Open review</Link>
            </>
          )}
          <div className="assistant-source">
            <label htmlFor={`assistant-source-${brief?.id ?? record.id}`}>Inspect source</label>
            <select
              id={`assistant-source-${brief?.id ?? record.id}`}
              value={inspectedField}
              onChange={(event) =>
                setInspected({
                  field: event.target.value as FieldName,
                  revision: inspectedRevision.number,
                })
              }
            >
              {(Object.keys(fieldLabels) as FieldName[]).map((field) => (
                <option key={field} value={field}>
                  {fieldLabels[field]}
                </option>
              ))}
            </select>
            <p className="small">Revision {inspectedRevision.number}</p>
            {inspectedRevision.number !== source.number && (
              <button className="text-button" onClick={() => setInspected(null)}>
                Use current source
              </button>
            )}
            <div className="assistant-source-text" ref={sourceText} tabIndex={0}>
              {fieldText(inspectedRevision.fields, inspectedField) || 'No value recorded'}
            </div>
          </div>
          <p className="small">
            {repository.mode === 'demo'
              ? 'Simulated assistance uses local fixtures; no AI is called.'
              : 'AI output is a proposal. Check its source before accepting it.'}
          </p>
          {!brief && (
            <p className="small">
              These results are private to the author and assigned reviewers. Summaries and
              suggested edits support the review; approval requires a successful requirement review
              and both assigned leads.
            </p>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={clearDialog}
        onOpenChange={setClearDialog}
        title="Clear chat for you?"
        description="Hides this conversation’s existing messages for your account on this device. Running tasks continue and new activity will appear. You can restore messages. Saved requirements, reviews and approvals are retained."
      >
        <ErrorNotice error={history.error} />
        <div className="dialog-actions">
          <button className="button" onClick={() => setClearDialog(false)}>
            Cancel
          </button>
          <button className="button primary" onClick={() => changeHistory(true)}>
            Clear chat
          </button>
        </div>
      </ConfirmDialog>
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
