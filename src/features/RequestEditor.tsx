import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Upload, ArrowLeft, Paperclip } from 'lucide-react';
import {
  draftSchema,
  emptyFields,
  fieldLabels,
  type DraftInput,
  type FieldName,
  type FileMeta,
} from '../../shared/contracts';
import {
  canonicalJson,
  currentRevision,
  DomainError,
  validateReviewerAssignment,
} from '../../shared/domain';
import { useWorkspace } from '../app/session';
import { draftFromRecord } from '../lib/demo';
import { ConfirmDialog, ErrorNotice, Loading, PageHeader, formatBytes } from '../components/ui';
import { useRequest } from './hooks';
import { RequestBuilder } from './RequestBuilder';

export function RequestEditor() {
  const { id } = useParams(),
    navigate = useNavigate(),
    { repository, context } = useWorkspace(),
    queries = useQueryClient(),
    query = useRequest(id);
  const [error, setError] = useState<unknown>(null),
    [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState(false),
    [files, setFiles] = useState<FileMeta[]>([]),
    [baseRevision, setBaseRevision] = useState(0);
  const commandKey = useRef({ key: crypto.randomUUID(), payload: '' });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [assistantApplied, setAssistantApplied] = useState(false);
  const [submitDraft, setSubmitDraft] = useState<DraftInput | null>(null);
  const form = useForm<DraftInput>({
    resolver: zodResolver(draftSchema),
    defaultValues: {
      fields: emptyFields(),
      productReviewerId: '',
      engineeringReviewerId: '',
      checklistVersion: context.checklist.id,
      fileIds: [],
    },
  });
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { isDirty, errors },
  } = form;
  useEffect(() => {
    if (query.data) {
      reset(draftFromRecord(query.data));
      setFiles(currentRevision(query.data).files);
      setBaseRevision(query.data.currentRevision);
    }
  }, [query.data?.id, reset]);
  useEffect(() => {
    if (!isDirty) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const link = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target.closest('a') : null;
      if (
        target &&
        target.origin === location.origin &&
        target.pathname !== location.pathname &&
        !window.confirm('Leave this page? Your unsaved changes will be lost.')
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', link, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', link, true);
    };
  }, [isDirty]);
  const criteria = watch('fields.criteria'),
    references = watch('fields.references'),
    fileIds = watch('fileIds'),
    unscheduled = watch('fields.unscheduled');
  async function save(draft: DraftInput, submit = false) {
    setError(null);
    setSaving(true);
    const payload = canonicalJson({ id, baseRevision, draft });
    if (commandKey.current.payload !== payload)
      commandKey.current = { key: crypto.randomUUID(), payload };
    try {
      if (submit)
        validateReviewerAssignment(
          draft.productReviewerId,
          draft.engineeringReviewerId,
          context.currentUser.id,
          context.members,
        );
      let record = id
        ? await repository.command(
            id,
            { action: 'save', expectedRevision: baseRevision, draft },
            commandKey.current.key,
          )
        : await repository.create(draft, commandKey.current.key);
      let creationError: string | undefined;
      if (submit) {
        try {
          record = await repository.command(
            record.id,
            { action: 'review', expectedRevision: record.currentRevision },
            `${commandKey.current.key}:submit`,
          );
        } catch (failure) {
          creationError = `Your draft was saved, but submission could not be confirmed. ${failure instanceof Error ? failure.message : 'Open the request and check its status before retrying submission.'}`;
        }
      }
      reset(draft);
      commandKey.current = { key: crypto.randomUUID(), payload: '' };
      void queries.invalidateQueries({ queryKey: ['requests'] });
      queries.setQueryData(['request', repository.mode, context.currentUser.id, record.id], record);
      navigate(`/requests/${record.id}`, { state: { creationError } });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }
  async function upload(selected: FileList | null) {
    if (!id || !selected) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(selected)) {
        const uploaded = await repository.upload(id, file);
        setFiles((previous) => [...previous, uploaded]);
        setValue('fileIds', [...form.getValues('fileIds'), uploaded.id], { shouldDirty: true });
      }
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }
  const field = (key: Exclude<FieldName, 'criteria'>, help?: string, rows = 3) => {
    const err = errors.fields?.[key];
    return (
      <div className="form-field" id={`field-${key}`}>
        <label htmlFor={key}>
          {fieldLabels[key]} <span className="required-label">Required for review</span>
        </label>
        {help && (
          <p id={`${key}-help`} className="field-help">
            {help}
          </p>
        )}
        {key === 'title' ? (
          <input
            id={key}
            {...register(`fields.${key}`)}
            maxLength={120}
            aria-invalid={!!err}
            aria-describedby={err ? `${key}-error` : help ? `${key}-help` : undefined}
          />
        ) : (
          <textarea
            id={key}
            rows={rows}
            {...register(`fields.${key}`)}
            maxLength={3000}
            aria-invalid={!!err}
            aria-describedby={err ? `${key}-error` : help ? `${key}-help` : undefined}
          />
        )}{' '}
        {err && (
          <p className="field-error" id={`${key}-error`}>
            {err.message}
          </p>
        )}
      </div>
    );
  };
  if (id && query.isPending) return <Loading />;
  if (id && query.error)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (query.data && query.data.authorId !== context.currentUser.id)
    return (
      <>
        <PageHeader title="Requirements are owned by the author" />
        <p>You can add a clarification comment on the request.</p>
        <Link className="button" to={`/requests/${id}`}>
          Open request
        </Link>
      </>
    );
  if (query.data?.archived)
    return (
      <ErrorNotice error={new DomainError('ARCHIVED', 'Restore this request before editing.')} />
    );
  return (
    <>
      <Link className="back-link" to={id ? `/requests/${id}` : '/requests'}>
        <ArrowLeft size={16} />
        Back to {id ? 'request' : 'requests'}
      </Link>
      <PageHeader
        title={id ? 'Edit feature request' : 'New feature request'}
        description="Describe the problem and the observable behavior engineering should build."
      />
      {!id && !builderOpen && (
        <div className="builder-entry">
          <div>
            <h2>Start with a conversation</h2>
            <p>Describe your idea, answer missing-detail questions, then review the filled form.</p>
          </div>
          <button
            className="button"
            onClick={() => {
              if (
                !isDirty ||
                window.confirm(
                  'Start with the assistant? Your unsaved form fields will be replaced when you use its preview.',
                )
              )
                setBuilderOpen(true);
            }}
          >
            Describe with assistant
          </button>
        </div>
      )}
      {!id && builderOpen && (
        <RequestBuilder
          key={context.currentUser.id}
          onManual={() => setBuilderOpen(false)}
          onApply={(fields) => {
            setValue('fields', fields, { shouldDirty: true });
            setAssistantApplied(true);
            setBuilderOpen(false);
            requestAnimationFrame(() => document.getElementById('title')?.focus());
          }}
        />
      )}
      {assistantApplied && !builderOpen && (
        <p className="notice neutral">
          Proposed fields added. Check and edit them, choose both leads, then save privately or
          submit for review. Nothing has been created yet.
        </p>
      )}
      <form
        hidden={builderOpen}
        className="editor-layout"
        onSubmit={handleSubmit(
          (draft) => save(draft),
          () => {
            setError(new Error('Check the highlighted fields before saving.'));
          },
        )}
        noValidate
      >
        <aside className="editor-sections" aria-label="Form sections">
          <a href="#problem-section">1. Problem</a>
          <a href="#behavior-section">2. Expected behavior</a>
          <a href="#context-section">3. Engineering context</a>
          <a href="#references-section">4. References</a>
          <a href="#reviewers-section">5. Reviewers</a>
        </aside>
        <div className="editor-main">
          <ErrorNotice error={error} />
          {query.data && query.data.currentRevision !== baseRevision && (
            <div className="notice attention">
              A newer revision was saved. Your local changes are preserved.{' '}
              <Link to={`/requests/${id}?tab=history`}>Compare revisions</Link> before continuing.
            </div>
          )}
          <section id="problem-section" className="form-section">
            <h2>
              <span className="section-number">1</span>Problem
            </h2>
            {field('title', 'Name the behavior, such as “Export reports by date range”.', 1)}
            {field(
              'problem',
              'Explain the current problem and its evidence. State when evidence is still missing.',
            )}
            {field('audience', 'Which users and roles need this feature?', 2)}
            {field(
              'successMeasure',
              'Describe a measurable or observable result. Do not invent a numerical target.',
              2,
            )}
          </section>
          <section id="behavior-section" className="form-section">
            <h2>
              <span className="section-number">2</span>Expected behavior
            </h2>
            {field('behavior', 'Describe the main flow and what the user sees.', 4)}
            <div className="form-grid">
              {field('scope', undefined, 3)}
              {field('exclusions', undefined, 3)}
            </div>
            <div className="form-field" id="field-criteria">
              <label>
                Acceptance criteria <span className="required-label">Required for review</span>
              </label>
              <p className="field-help">
                Use testable outcomes. Example: Given an analyst, when they select a date range,
                then the export contains matching rows.
              </p>
              {criteria.map((_criterion, index) => (
                <div className="criterion-row" key={index}>
                  <span>{index + 1}.</span>
                  <textarea
                    aria-label={`Acceptance criterion ${index + 1}`}
                    rows={2}
                    maxLength={1000}
                    {...register(`fields.criteria.${index}`)}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove criterion ${index + 1}`}
                    onClick={() =>
                      setValue(
                        'fields.criteria',
                        criteria.filter((_, i) => i !== index),
                        { shouldDirty: true },
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button small-button"
                disabled={criteria.length >= 20}
                onClick={() =>
                  setValue('fields.criteria', [...criteria, ''], { shouldDirty: true })
                }
              >
                <Plus size={15} />
                Add criterion
              </button>
              {errors.fields?.criteria && (
                <p className="field-error">
                  Check acceptance criteria. Use at most 20 criteria, each below 1,000 characters.
                </p>
              )}
            </div>
          </section>
          <section id="context-section" className="form-section">
            <h2>
              <span className="section-number">3</span>Engineering context
            </h2>
            {field(
              'edgeCases',
              'Cover failures, empty results, and permission cases. Explain if none apply.',
            )}
            {field(
              'dependencies',
              'List dependencies and constraints, or state “No known dependencies”.',
              2,
            )}
            {field('dataImpact', 'Which data and permissions change, or stay the same?', 3)}
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="priority">Priority</label>
                <select id="priority" {...register('fields.priority')}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
              {field('rationale', undefined, 2)}
            </div>
            <div className="form-field">
              <label className="checkbox-label">
                <input type="checkbox" {...register('fields.unscheduled')} />
                Target delivery is not scheduled
              </label>
              {!unscheduled && (
                <div className="form-grid">
                  <div>
                    <label htmlFor="targetDate">Desired date</label>
                    <input id="targetDate" type="date" {...register('fields.targetDate')} />
                  </div>
                  <div>
                    <label htmlFor="timezone">Timezone</label>
                    <input
                      id="timezone"
                      {...register('fields.timezone')}
                      placeholder="Asia/Karachi"
                    />
                    {errors.fields?.timezone && (
                      <p className="field-error">{errors.fields.timezone.message}</p>
                    )}
                  </div>
                </div>
              )}
              <p className="field-help">
                A desired date is context for the reviewers, not a delivery commitment.
              </p>
            </div>
          </section>
          <section id="references-section" className="form-section">
            <h2>
              <span className="section-number">4</span>References{' '}
              <span className="optional-label">Optional</span>
            </h2>
            <p className="field-help">
              Links and files are supporting references. Their contents are not reviewed by AI.
            </p>
            {references.map((_reference, index) => (
              <div className="reference-editor" key={index}>
                <input
                  aria-label={`Reference ${index + 1} label`}
                  placeholder="Label"
                  {...register(`fields.references.${index}.label`)}
                />
                <input
                  aria-label={`Reference ${index + 1} URL`}
                  placeholder="https://…"
                  {...register(`fields.references.${index}.url`)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove reference ${index + 1}`}
                  onClick={() =>
                    setValue(
                      'fields.references',
                      references.filter((_, i) => i !== index),
                      { shouldDirty: true },
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
                {errors.fields?.references?.[index]?.url && (
                  <p className="field-error">Use a valid HTTPS URL.</p>
                )}
              </div>
            ))}
            <button
              className="button small-button"
              type="button"
              disabled={references.length >= 10}
              onClick={() =>
                setValue('fields.references', [...references, { label: '', url: '' }], {
                  shouldDirty: true,
                })
              }
            >
              <Plus size={15} />
              Add link
            </button>
            <div className="upload-zone">
              <Upload size={21} />
              <label htmlFor="attachments">Screenshots or PDFs</label>
              <p>PNG, JPEG, or PDF. Up to 5 MB each, 5 retained files per request.</p>
              <input
                id="attachments"
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                multiple
                disabled={!id || uploading}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = '';
                }}
              />
              {!id && <span className="small">Save the draft first to attach files.</span>}
              {uploading && <span role="status">Uploading and checking files…</span>}
            </div>
            {files
              .filter((f) => fileIds.includes(f.id))
              .map((file) => (
                <div className="file-row" key={file.id}>
                  <Paperclip size={16} />
                  <span>
                    {file.name}
                    <small>
                      {formatBytes(file.size)} ·{' '}
                      {currentRevisionIfAttached(file.id, query.data?.revisions.at(-1)?.files)
                        ? 'Attached to saved revision'
                        : 'Ready to attach — save this revision'}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setValue(
                        'fileIds',
                        fileIds.filter((fid) => fid !== file.id),
                        { shouldDirty: true },
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
          </section>
          <section id="reviewers-section" className="form-section">
            <h2>
              <span className="section-number">5</span>Reviewers
            </h2>
            <p className="field-help">
              Choose a product lead and an engineering lead. Neither can be the author.
            </p>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="productReviewer">Product lead</label>
                <select id="productReviewer" {...register('productReviewerId')}>
                  <option value="">Choose a lead</option>
                  {context.members
                    .filter(
                      (m) =>
                        m.role === 'product_lead' &&
                        m.status === 'active' &&
                        m.id !== context.currentUser.id,
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="engineeringReviewer">Engineering lead</label>
                <select id="engineeringReviewer" {...register('engineeringReviewerId')}>
                  <option value="">Choose a lead</option>
                  {context.members
                    .filter(
                      (m) =>
                        m.role === 'engineering_lead' &&
                        m.status === 'active' &&
                        m.id !== context.currentUser.id,
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <label className="form-field">
              Checklist
              <select {...register('checklistVersion')}>
                <option value={context.checklist.id}>{context.checklist.name}</option>
                {query.data &&
                  currentRevision(query.data).checklistVersion !== context.checklist.id && (
                    <option value={currentRevision(query.data).checklistVersion}>
                      Checklist used by this request
                    </option>
                  )}
              </select>
            </label>
          </section>
          <div className="save-bar">
            <div>
              <strong>{isDirty ? 'Unsaved changes' : 'No unsaved changes'}</strong>
              <span>
                {id
                  ? 'Saving creates a revision and requires both approvals again.'
                  : 'Drafts can be saved while incomplete.'}
              </span>
            </div>
            <div className="header-actions">
              <button className="button primary" type="submit" disabled={saving || uploading}>
                {saving ? 'Saving…' : id ? 'Save revision' : 'Save draft'}
              </button>
              {!id && (
                <button
                  className="button"
                  type="button"
                  disabled={saving || uploading}
                  onClick={() =>
                    void handleSubmit(
                      (input) => {
                        try {
                          validateReviewerAssignment(
                            input.productReviewerId,
                            input.engineeringReviewerId,
                            context.currentUser.id,
                            context.members,
                          );
                          setSubmitDraft(structuredClone(input));
                          setError(null);
                        } catch (failure) {
                          setError(failure);
                        }
                      },
                      () => setError(new Error('Check the highlighted fields before submitting.')),
                    )()
                  }
                >
                  Create and submit for review
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={!!submitDraft}
        onOpenChange={(open) => {
          if (!open && !saving) setSubmitDraft(null);
        }}
        title="Create and submit this request?"
        description="This creates revision 1 from the form you reviewed and starts its requirement review. The two assigned leads will be able to read it. Neither approval is automatic."
      >
        {submitDraft && (
          <>
            <h3>{submitDraft.fields.title || 'Untitled feature'}</h3>
            <p>
              Product lead:{' '}
              {context.members.find((member) => member.id === submitDraft.productReviewerId)?.name}
              <br />
              Engineering lead:{' '}
              {
                context.members.find((member) => member.id === submitDraft.engineeringReviewerId)
                  ?.name
              }
            </p>
          </>
        )}
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <button className="button" disabled={saving} onClick={() => setSubmitDraft(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={saving}
            onClick={() => {
              if (submitDraft) void save(submitDraft, true);
            }}
          >
            {saving ? 'Creating…' : 'Confirm and submit'}
          </button>
        </div>
      </ConfirmDialog>
    </>
  );
}
function currentRevisionIfAttached(id: string, files: FileMeta[] | undefined): boolean {
  return !!files?.some((f) => f.id === id);
}
