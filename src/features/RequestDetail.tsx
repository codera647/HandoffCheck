import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Pencil,
  RotateCw,
  Paperclip,
  Download,
  Check,
  MessageSquare,
  Archive,
  FileText,
} from 'lucide-react';
import {
  fieldLabels,
  type Command,
  type FieldName,
  type RequestRecord,
} from '../../shared/contracts';
import {
  activeApprovals,
  approvalStage,
  assignedLead,
  blockingFindings,
  canReview,
  currentReview,
  currentRevision,
} from '../../shared/domain';
import { useWorkspace } from '../app/session';
import {
  ConfirmDialog,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  Success,
  formatBytes,
  formatDate,
} from '../components/ui';
import { useCommand, useRequest } from './hooks';
import { AssistancePanel } from './AssistancePanel';

export function RequestDetail() {
  const { id } = useParams(),
    query = useRequest(id),
    { repository, context } = useWorkspace(),
    mutation = useCommand(id!),
    [params, setParams] = useSearchParams();
  const [confirm, setConfirm] = useState<{
      stage: 'product' | 'engineering';
      revision: number;
      reviewId: string;
      title: string;
    } | null>(null),
    [changeDialog, setChangeDialog] = useState(false),
    [reason, setReason] = useState(''),
    [comment, setComment] = useState(''),
    [message, setMessage] = useState(''),
    [localError, setLocalError] = useState<unknown>(null);
  const tab = params.get('tab') || 'requirements';
  if (query.isPending) return <Loading />;
  if (query.error || !query.data)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const record = query.data,
    rev = currentRevision(record),
    review = currentReview(record),
    actor = context.currentUser,
    approvals = activeApprovals(record),
    stage = approvalStage(record, actor),
    blockers = blockingFindings(review),
    brief = record.briefs.find((b) => b.revision === rev.number);
  const name = (uid: string) => context.members.find((m) => m.id === uid)?.name || 'Not assigned';
  async function run(command: Command, success: string) {
    setMessage('');
    setLocalError(null);
    await mutation.mutateAsync({ command, key: crypto.randomUUID() });
    setMessage(success);
  }
  const execute = (command: Command, success: string) => {
    void run(command, success).catch(() => undefined);
  };
  const reviewExpired = review?.state === 'running' && Date.parse(review.expiresAt) < Date.now();
  const canRunReview =
    !record.archived &&
    canReview(record, actor) &&
    !brief &&
    (!review || review.state !== 'running' || reviewExpired) &&
    rev.number >= record.minimumApprovalRevision;
  const awaitingYourApproval =
    !!stage && !record.archived && !brief && !approvals.some((a) => a.stage === stage);
  const approvalBlockedReason =
    rev.number < record.minimumApprovalRevision
      ? 'The author must save a new revision to address the requested changes before approval.'
      : review?.state === 'error'
        ? 'Approval is blocked because the requirement review failed. Check the error in Review, then retry review. Summaries and suggested edits do not unlock approval.'
        : review?.state === 'running'
          ? reviewExpired
            ? 'Approval is blocked because the review timed out. Retry review.'
            : 'Approval will be available after the requirement review finishes and blocking questions are resolved.'
          : !review ||
              review.state !== 'succeeded' ||
              review.inputHash !== rev.inputHash ||
              review.revision !== rev.number
            ? 'Submit this revision for review before approving it.'
            : blockers.length
              ? 'Resolve the blocking questions in Review before approving this revision.'
              : !['ready_for_approval', 'partially_approved'].includes(record.status)
                ? 'This revision is not awaiting approval. Check its review and current status.'
                : null;
  const canApprove = awaitingYourApproval && !approvalBlockedReason;
  const chooseTab = (value: string) => setParams(value === 'requirements' ? {} : { tab: value });
  return (
    <>
      <Link className="back-link" to="/requests">
        <ArrowLeft size={16} />
        All requests
      </Link>
      <PageHeader
        title={record.title}
        actions={
          <>
            {actor.id === record.authorId && !record.archived && (
              <Link className="button" to={`/requests/${id}/edit`}>
                <Pencil size={16} />
                Edit request
              </Link>
            )}
            {(actor.id === record.authorId || actor.role === 'admin') && (
              <button
                className="button"
                disabled={mutation.isPending}
                onClick={() =>
                  execute(
                    { action: 'archive', expectedRevision: rev.number, archived: !record.archived },
                    record.archived ? 'Request restored.' : 'Request archived.',
                  )
                }
              >
                <Archive size={16} />
                {record.archived ? 'Restore' : 'Archive'}
              </button>
            )}
          </>
        }
      />
      <div className="request-context">
        <span className="request-id">HC-{String(record.number).padStart(4, '0')}</span>
        <span>Revision {rev.number}</span>
        <StatusBadge status={record.status} archived={record.archived} />
        <span>
          By {name(record.authorId)} · {formatDate(record.updatedAt, context.workspace.timezone)}
        </span>
      </div>
      <ErrorNotice error={mutation.error || localError} retry={() => void query.refetch()} />
      {message && <Success>{message}</Success>}
      <div className="detail-tabs" role="tablist" aria-label="Request views">
        {[
          ['requirements', 'Requirements'],
          ['review', `Review${blockers.length ? ` (${blockers.length})` : ''}`],
          ['approvals', 'Approvals'],
          ['history', 'History'],
        ].map(([value, label], index) => (
          <button
            key={value}
            role="tab"
            id={`tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const tabs = ['requirements', 'review', 'approvals', 'history'];
                const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : 3)) % 4];
                chooseTab(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
            onClick={() => chooseTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="detail-layout">
        <section
          className="detail-main"
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
        >
          {tab === 'requirements' && (
            <>
              <div className="requirement-intro">
                <h2>Requirements</h2>
                <span className="small">Checklist pinned to this revision</span>
              </div>
              {(Object.keys(fieldLabels) as FieldName[])
                .filter((f) => f !== 'title')
                .map((field) => (
                  <section className="requirement-section" id={`field-${field}`} key={field}>
                    <h3>{fieldLabels[field]}</h3>
                    {field === 'criteria' ? (
                      <ol>
                        {rev.fields.criteria
                          .filter((c) => c.trim())
                          .map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                      </ol>
                    ) : (
                      <p className={!String(rev.fields[field]).trim() ? 'missing-value' : ''}>
                        {String(rev.fields[field]) || 'No value provided'}
                      </p>
                    )}
                  </section>
                ))}
              <div className="requirement-section">
                <h3>Priority and delivery</h3>
                <p>
                  {rev.fields.priority.charAt(0).toUpperCase() + rev.fields.priority.slice(1)}{' '}
                  priority ·{' '}
                  {rev.fields.unscheduled
                    ? 'Not scheduled'
                    : `${rev.fields.targetDate} (${rev.fields.timezone})`}
                </p>
              </div>
              <section className="requirement-section">
                <h3>References and files</h3>
                {!rev.fields.references.length && !rev.files.length && (
                  <p className="missing-value">No supporting references.</p>
                )}
                {rev.fields.references.map((ref, i) => (
                  <p key={i}>
                    <a href={ref.url} target="_blank" rel="noopener noreferrer">
                      {ref.label || ref.url} ↗
                    </a>
                  </p>
                ))}
                {rev.files.map((file) => (
                  <div className="file-row" key={file.id}>
                    <Paperclip size={16} />
                    <span>
                      {file.name}
                      <small>
                        {formatBytes(file.size)} ·{' '}
                        {file.type === 'application/pdf' ? 'PDF' : 'Screenshot'}
                      </small>
                    </span>
                    <button
                      className="button small-button"
                      onClick={async () => {
                        try {
                          const result = await repository.download(file.id);
                          const link = document.createElement('a');
                          link.href = result.url;
                          link.download = result.name;
                          link.rel = 'noopener';
                          link.click();
                          if (result.revoke) setTimeout(result.revoke, 1000);
                        } catch (e) {
                          setLocalError(e);
                        }
                      }}
                    >
                      <Download size={15} />
                      Download
                    </button>
                  </div>
                ))}
              </section>
            </>
          )}
          {tab === 'review' && (
            <>
              <h2>Review and clarification</h2>
              <p className="section-intro">
                Answer questions in the discussion, then update the requirement and recheck.
              </p>
              {!review ? (
                <p className="missing-value">This revision has not been reviewed.</p>
              ) : (
                <>
                  <div className="notice neutral">
                    {review.mode === 'checklist_only'
                      ? 'Checklist-only review. Language ambiguity has not been reviewed by AI.'
                      : 'AI language review and checklist.'}
                  </div>
                  {review.state === 'error' && (
                    <ErrorNotice
                      error={new Error(review.error || 'The review failed. Try again.')}
                    />
                  )}{' '}
                  {review.state === 'running' && (
                    <Loading
                      label={
                        reviewExpired
                          ? 'The review timed out. Try again.'
                          : `Reviewing revision ${review.revision}…`
                      }
                    />
                  )}{' '}
                  {review.state === 'succeeded' && !review.findings.length && (
                    <p className="review-clear">
                      <Check size={18} />
                      All required fields are present. Both leads still need to assess the feature.
                    </p>
                  )}
                  {!!review.unknowns.length && (
                    <section className="notice neutral">
                      <h3>Context the review could not assess</h3>
                      <ul>
                        {review.unknowns.map((unknown, index) => (
                          <li key={index}>{unknown}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {review.findings.map((f) => (
                    <article className={`finding ${f.resolution ? 'resolved' : ''}`} key={f.id}>
                      <div className="finding-heading">
                        <span
                          className={`badge ${f.severity === 'blocking' && !f.resolution ? 'attention' : 'neutral'}`}
                        >
                          {f.resolution
                            ? 'Dismissed'
                            : f.severity === 'blocking'
                              ? 'Blocking'
                              : 'Advisory'}
                        </span>
                        <span className="small">
                          {fieldLabels[f.field]} · {f.origin === 'ai' ? 'AI finding' : 'Checklist'}
                        </span>
                      </div>
                      <h3>{f.question}</h3>
                      {f.evidence ? (
                        <blockquote>{f.evidence}</blockquote>
                      ) : (
                        <p className="missing-value">No value provided</p>
                      )}
                      <p>{f.explanation}</p>
                      {f.resolution ? (
                        <p className="small">
                          Dismissed by {name(f.resolution.actorId)}: {f.resolution.reason}
                        </p>
                      ) : (
                        f.origin === 'ai' &&
                        assignedLead(record, actor) &&
                        !record.archived && (
                          <button
                            className="button small-button"
                            onClick={() => {
                              const response = window.prompt(
                                'Explain why this AI finding does not apply.',
                              );
                              if (response?.trim())
                                execute(
                                  {
                                    action: 'dismiss',
                                    expectedRevision: rev.number,
                                    reviewId: review.id,
                                    findingId: f.id,
                                    reason: response,
                                  },
                                  'Finding dismissed with a recorded reason.',
                                );
                            }}
                          >
                            Dismiss with reason
                          </button>
                        )
                      )}
                    </article>
                  ))}
                </>
              )}
              <section className="discussion">
                <h3>
                  <MessageSquare size={18} />
                  Discussion
                </h3>
                {record.comments.length ? (
                  record.comments.map((c) => (
                    <article className="comment" key={c.id}>
                      <div>
                        <strong>{name(c.authorId)}</strong>
                        <span>
                          Revision {c.revision} ·{' '}
                          {formatDate(c.createdAt, context.workspace.timezone)}
                        </span>
                      </div>
                      <p>{c.body}</p>
                    </article>
                  ))
                ) : (
                  <p className="missing-value">No comments yet.</p>
                )}
                {!record.archived && (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await run(
                          { action: 'comment', expectedRevision: rev.number, body: comment },
                          'Comment saved.',
                        );
                        setComment('');
                      } catch {
                        /* The mutation error is displayed above. */
                      }
                    }}
                  >
                    <label htmlFor="comment">Add a clarification answer or comment</label>
                    <textarea
                      id="comment"
                      rows={3}
                      maxLength={3000}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      required
                    />
                    <p className="field-help">
                      A comment does not change the requirements or their approval.
                    </p>
                    <button className="button" disabled={mutation.isPending || !comment.trim()}>
                      Post comment
                    </button>
                  </form>
                )}
              </section>
            </>
          )}
          {tab === 'approvals' && (
            <>
              <h2>Product and engineering approval</h2>
              <p className="section-intro">
                Each lead approves the same reviewed revision. Editing the requirements invalidates
                current approvals.
              </p>
              {(['product', 'engineering'] as const).map((s) => {
                const approval = approvals.find((a) => a.stage === s);
                return (
                  <div className="approval-row" key={s}>
                    <span className={`approval-symbol ${approval ? 'complete' : ''}`}>
                      <Check size={18} />
                    </span>
                    <div>
                      <h3>{s === 'product' ? 'Product approval' : 'Engineering approval'}</h3>
                      <p>
                        {name(s === 'product' ? rev.productReviewerId : rev.engineeringReviewerId)}
                      </p>
                      <span className="small">
                        {approval
                          ? `Approved revision ${approval.revision} · ${formatDate(approval.createdAt, context.workspace.timezone)}`
                          : 'Waiting for the current review and assigned lead'}
                      </span>
                    </div>
                    <span className={`badge ${approval ? 'success' : 'neutral'}`}>
                      {approval ? 'Approved' : 'Pending'}
                    </span>
                  </div>
                );
              })}
              {awaitingYourApproval && (
                <button
                  className="button primary"
                  disabled={!canApprove || mutation.isPending}
                  aria-describedby={!canApprove ? 'approval-blocked-reason' : undefined}
                  onClick={() =>
                    setConfirm({
                      stage: stage!,
                      revision: rev.number,
                      reviewId: review!.id,
                      title: record.title,
                    })
                  }
                >
                  Approve revision {rev.number}
                </button>
              )}
              {awaitingYourApproval && !canApprove && (
                <p className="notice neutral" id="approval-blocked-reason">
                  {approvalBlockedReason}{' '}
                  <button className="text-button" onClick={() => chooseTab('review')}>
                    Open review
                  </button>
                </p>
              )}
              {assignedLead(record, actor) && !record.archived && !brief && (
                <button
                  className="button changes-button"
                  onClick={() => {
                    setReason('');
                    setChangeDialog(true);
                  }}
                >
                  Request changes
                </button>
              )}
              <p className="small">
                {stage
                  ? 'Your approval applies only to your assigned stage.'
                  : 'Approval actions are available to the assigned leads.'}
              </p>
            </>
          )}
          {tab === 'history' && (
            <History record={record} name={name} timezone={context.workspace.timezone} />
          )}
        </section>
        <aside className="review-sidebar">
          <h2>Handoff status</h2>
          <StatusBadge status={record.status} archived={record.archived} />
          <p className="small">
            Revision {rev.number} · {blockers.length} blocking{' '}
            {blockers.length === 1 ? 'question' : 'questions'}
          </p>
          <div className="sidebar-section">
            <span className="eyebrow">Review</span>
            <p>{review?.mode === 'ai' ? 'AI + checklist' : 'Checklist only'}</p>
            {repository.mode === 'demo' && (
              <p className="small">AI language review is not enabled in this demo.</p>
            )}
            {canRunReview && (
              <button
                className="button full-width"
                disabled={mutation.isPending}
                onClick={() =>
                  execute(
                    { action: 'review', expectedRevision: rev.number },
                    'Review result saved.',
                  )
                }
              >
                <RotateCw size={15} />
                {mutation.isPending
                  ? 'Working…'
                  : reviewExpired || review?.state === 'error'
                    ? 'Retry review'
                    : review
                      ? 'Recheck revision'
                      : 'Submit for review'}
              </button>
            )}
            {rev.number < record.minimumApprovalRevision && (
              <p className="small">
                The author must save a new revision to address the requested changes.
              </p>
            )}
          </div>
          <div className="sidebar-section">
            <span className="eyebrow">Approvals</span>
            {(['product', 'engineering'] as const).map((s) => (
              <div className="mini-approval" key={s}>
                <Check
                  size={14}
                  className={approvals.some((a) => a.stage === s) ? 'text-success' : 'muted'}
                />
                <span>{s === 'product' ? 'Product' : 'Engineering'}</span>
                <strong>{approvals.some((a) => a.stage === s) ? 'Approved' : 'Pending'}</strong>
              </div>
            ))}
            {awaitingYourApproval && (
              <button
                className="button primary full-width"
                disabled={!canApprove || mutation.isPending}
                aria-describedby={!canApprove ? 'sidebar-approval-blocked-reason' : undefined}
                onClick={() =>
                  setConfirm({
                    stage: stage!,
                    revision: rev.number,
                    reviewId: review!.id,
                    title: record.title,
                  })
                }
              >
                Approve revision {rev.number}
              </button>
            )}
            {awaitingYourApproval && !canApprove && (
              <p className="small" id="sidebar-approval-blocked-reason">
                {approvalBlockedReason}
              </p>
            )}
          </div>
          <div className="sidebar-section">
            <span className="eyebrow">Implementation brief</span>
            {brief ? (
              <Link className="button full-width" to={`/briefs/${id}/${brief.id}`}>
                <FileText size={16} />
                Open brief <ArrowRight size={15} />
              </Link>
            ) : record.status === 'approved' && canReview(record, actor) && !record.archived ? (
              <button
                className="button primary full-width"
                disabled={mutation.isPending}
                onClick={() =>
                  execute(
                    { action: 'generate', expectedRevision: rev.number },
                    'Approved brief created.',
                  )
                }
              >
                <FileText size={16} />
                Generate brief
              </button>
            ) : (
              <p className="small">Available after both leads approve this revision.</p>
            )}
            {record.briefs
              .filter((b) => b.revision !== rev.number)
              .map((b) => (
                <Link key={b.id} className="historical-link" to={`/briefs/${id}/${b.id}`}>
                  Brief for revision {b.revision}
                </Link>
              ))}
          </div>
          <details className="technical-details">
            <summary>Technical details</summary>
            <span>Input SHA-256</span>
            <code>{rev.inputHash}</code>
            <span>Checklist</span>
            <code>{rev.checklistVersion}</code>
          </details>
        </aside>
      </div>
      <AssistancePanel record={record} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Approve revision ${confirm?.revision}`}
        description={`This records ${confirm?.stage} approval of “${confirm?.title}”, revision ${confirm?.revision}.`}
      >
        <ErrorNotice error={mutation.error} />
        <div className="dialog-actions">
          <button className="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending}
            onClick={async () => {
              if (confirm && review) {
                try {
                  await run(
                    {
                      action: 'approve',
                      expectedRevision: confirm.revision,
                      reviewId: confirm.reviewId,
                      stage: confirm.stage,
                    },
                    `${confirm.stage === 'product' ? 'Product' : 'Engineering'} approval recorded for revision ${confirm.revision}.`,
                  );
                  setConfirm(null);
                } catch {
                  /* Keep the dialog open and display the server error. */
                }
              }
            }}
          >
            Approve revision {confirm?.revision}
          </button>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={changeDialog}
        onOpenChange={setChangeDialog}
        title="Request changes"
        description={`The author will need to save and review a new revision of “${record.title}”.`}
      >
        <label htmlFor="changes-reason">What needs to change?</label>
        <textarea
          id="changes-reason"
          rows={4}
          value={reason}
          maxLength={3000}
          onChange={(e) => setReason(e.target.value)}
        />
        <ErrorNotice error={mutation.error} />
        <div className="dialog-actions">
          <button className="button" onClick={() => setChangeDialog(false)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!reason.trim() || mutation.isPending}
            onClick={async () => {
              try {
                await run(
                  { action: 'changes', expectedRevision: rev.number, reason },
                  'Changes requested. A new revision is required.',
                );
                setChangeDialog(false);
              } catch {
                /* Server error remains visible in the dialog. */
              }
            }}
          >
            Record changes request
          </button>
        </div>
      </ConfirmDialog>
    </>
  );
}
function History({
  record,
  name,
  timezone,
}: {
  record: RequestRecord;
  name(id: string): string;
  timezone: string;
}) {
  const [selected, setSelected] = useState(record.currentRevision),
    revision = record.revisions.find((r) => r.number === selected)!,
    previous = record.revisions.find((r) => r.number === selected - 1);
  return (
    <>
      <h2>Revision history</h2>
      <label className="history-select">
        Revision
        <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
          {[...record.revisions].reverse().map((r) => (
            <option key={r.id} value={r.number}>
              Revision {r.number} · {formatDate(r.createdAt, timezone)}
            </option>
          ))}
        </select>
      </label>
      <p className="small">
        Saved by {name(revision.editorId)}. Compared with{' '}
        {previous ? `revision ${previous.number}` : 'the initial empty request'}.
      </p>
      {(Object.keys(fieldLabels) as FieldName[]).map((field) => {
        const before = previous?.fields[field],
          after = revision.fields[field];
        if (JSON.stringify(before) === JSON.stringify(after)) return null;
        return (
          <section className="field-diff" key={field}>
            <h3>{fieldLabels[field]}</h3>
            <div>
              <span>Previous</span>
              <p>{Array.isArray(before) ? before.join('\n') : before || 'No value'}</p>
            </div>
            <div>
              <span>Current</span>
              <p>{Array.isArray(after) ? after.join('\n') : after || 'No value'}</p>
            </div>
          </section>
        );
      })}
      <section className="requirement-section">
        <h3>Reviewers, files, and checklist</h3>
        <p>
          Product: {name(revision.productReviewerId)} · Engineering:{' '}
          {name(revision.engineeringReviewerId)}
        </p>
        <p>Files: {revision.files.map((f) => f.name).join(', ') || 'None'}</p>
        <p className="small">Checklist: {revision.checklistVersion}</p>
      </section>
      <h3>Workflow events</h3>
      <ol className="event-list">
        {[...record.events].reverse().map((e) => (
          <li key={e.id}>
            <strong>{e.action.replaceAll('_', ' ')}</strong>
            <span>
              {name(e.actorId)} · Revision {e.revision} · {formatDate(e.createdAt, timezone)}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}
