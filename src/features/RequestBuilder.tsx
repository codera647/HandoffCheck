import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CircleHelp,
  FileText,
  LockKeyhole,
  MessageSquare,
  RotateCcw,
  Send,
} from 'lucide-react';
import { fieldLabels, type FeatureFields } from '../../shared/contracts';
import { DomainError } from '../../shared/domain';
import {
  intakeFields,
  intakeInputSchema,
  missingIntakeFields,
  type IntakeInput,
  type IntakeResult,
} from '../../shared/intake';
import { useWorkspace } from '../app/session';
import { ConfirmDialog, ErrorNotice } from '../components/ui';

type Turn = { text: string; role: 'user' | 'assistant'; result?: IntakeResult };

export function RequestBuilder({
  onApply,
  onManual,
}: {
  onApply(fields: FeatureFields): void;
  onManual(): void;
}) {
  const { repository, context } = useWorkspace();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failed, setFailed] = useState<{ input: IntakeInput; key: string } | null>(null);
  const [restart, setRestart] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const policy = useQuery({
    queryKey: ['automation-policy', repository.mode, context.workspace.id],
    queryFn: () => repository.automationPolicy(),
  });
  const ready = policy.data?.aiEnabled && policy.data.providerConfigured;
  const lastResult = [...turns].reverse().find((turn) => turn.result)?.result;
  const fields = lastResult ? intakeFields(lastResult.response, context.workspace.timezone) : null;
  const missing = fields ? missingIntakeFields(fields) : [];
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [turns.length, pending]);
  useEffect(() => {
    if (!turns.length && !text) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const leave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (
        link &&
        link.origin === location.origin &&
        link.pathname !== location.pathname &&
        !window.confirm(
          'Leave the request assistant? This conversation and preview are not saved in your browser.',
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', leave, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', leave, true);
    };
  }, [turns.length, text]);

  async function execute(input: IntakeInput, key: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setConfirmed(false);
    try {
      const result = await repository.intake(input, key);
      const answer = [result.response.summary, result.response.question?.text]
        .filter(Boolean)
        .join('\n\n');
      setTurns((previous) => [...previous, { role: 'assistant', text: answer, result }]);
      setFailed(null);
    } catch (failure) {
      setError(failure);
      setFailed({ input, key });
    } finally {
      setPending(false);
      busy.current = false;
    }
  }
  function send(value = text) {
    if (!value.trim() || pending || failed) return;
    try {
      const input = intakeInputSchema.parse({
        messages: [
          ...turns.map(({ role, text }) => ({ role, text })),
          { role: 'user', text: value.trim() },
        ],
      });
      setTurns((previous) => [...previous, { role: 'user', text: value.trim() }]);
      setText('');
      void execute(input, crypto.randomUUID());
    } catch {
      setError(
        new Error(
          'This conversation is too long. Use the current preview in the form or start again.',
        ),
      );
    }
  }
  return (
    <section className="request-builder" aria-label="Request drafting assistant">
      <div className="builder-heading">
        <div>
          <h2>
            <MessageSquare size={20} aria-hidden="true" />
            Describe your feature
          </h2>
          <p>
            Explain the idea in your own words. Answer one question at a time, then check the
            proposed form.
          </p>
        </div>
        <button className="text-button" disabled={pending} onClick={() => setRestart(true)}>
          <RotateCcw size={14} aria-hidden="true" />
          Start again
        </button>
      </div>
      <p className="builder-privacy">
        <LockKeyhole size={14} aria-hidden="true" />
        No request is created until you save the form. Reviewers are selected by you.
      </p>
      {repository.mode === 'demo' && (
        <p className="notice neutral">
          Simulated conversation: this demo copies your answers into fields. It does not call
          Gemini.
        </p>
      )}
      <div className="builder-layout">
        <div className="builder-conversation">
          <div
            className="builder-thread"
            role="log"
            aria-label="Drafting conversation"
            tabIndex={0}
          >
            {!turns.length && (
              <div className="builder-welcome">
                <MessageSquare size={24} aria-hidden="true" />
                <h3>What would you like to build?</h3>
                <p>
                  Describe the problem, who needs the feature, and what they should be able to do.
                  It is fine if you do not have every detail yet.
                </p>
                <p className="small">
                  Example: “Our analysts copy report rows into spreadsheets. I want them to export a
                  date range as CSV.”
                </p>
              </div>
            )}
            {turns.map((turn, index) => (
              <div key={index} className={`builder-message ${turn.role}`}>
                <span className="builder-message-label">
                  {turn.role === 'user'
                    ? 'You'
                    : turn.result?.demo
                      ? 'Simulated assistant'
                      : 'Request assistant'}
                </span>
                {turn.role === 'user' ? (
                  <p>{turn.text}</p>
                ) : (
                  <>
                    <p>{turn.result?.response.summary}</p>
                    {turn.result?.response.question && (
                      <div className="builder-question">
                        <h3>
                          <CircleHelp size={16} aria-hidden="true" />
                          {turn.result.response.question.text}
                        </h3>
                        {index === turns.length - 1 && !failed && (
                          <div className="builder-options">
                            {turn.result.response.question.options.map((option, optionIndex) => (
                              <button
                                key={optionIndex}
                                disabled={pending || !ready}
                                onClick={() => send(option.value)}
                              >
                                <strong>{option.label}</strong>
                                {option.recommended && (
                                  <span className="badge neutral">Suggested</span>
                                )}
                                <span>{option.value}</span>
                                {option.reason && <small>{option.reason}</small>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {turn.result?.model && <span className="small">{turn.result.model}</span>}
                  </>
                )}
              </div>
            ))}
            {pending && (
              <p role="status" className="builder-pending">
                Reading your answer and updating the proposed draft…
              </p>
            )}
            <div ref={end} />
          </div>
          <div className="builder-input">
            <ErrorNotice error={error || policy.error} />
            {failed && (
              <div className="builder-recovery">
                <p className="small">Your message and previous preview are retained.</p>
                <button
                  className="button"
                  disabled={pending}
                  onClick={() =>
                    void execute(
                      failed.input,
                      error instanceof DomainError && error.code === 'AI_PROVIDER'
                        ? crypto.randomUUID()
                        : failed.key,
                    )
                  }
                >
                  Retry message
                </button>
              </div>
            )}
            {policy.data && !ready && (
              <p className="notice neutral">
                The request assistant is disabled or Gemini is not configured. An administrator can
                enable AI in Settings → Automation. You can fill the form manually.
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <label htmlFor="builder-answer">
                {turns.length ? 'Your answer or correction' : 'Describe your idea'}
              </label>
              <textarea
                id="builder-answer"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setConfirmed(false);
                }}
                rows={3}
                maxLength={3000}
                disabled={pending || !!failed}
                placeholder="Describe the behavior you need…"
              />
              <div className="builder-input-actions">
                <span className="small">{text.length}/3,000 · Each turn uses one AI attempt.</span>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!ready || pending || !!failed || !text.trim()}
                >
                  <Send size={15} aria-hidden="true" />
                  {pending ? 'Working…' : 'Send message'}
                </button>
              </div>
            </form>
          </div>
        </div>
        <aside className="builder-preview" aria-label="Proposed request preview">
          <h2>
            <FileText size={18} aria-hidden="true" />
            Proposed form
          </h2>
          <p className="small">AI wording is a proposal. Check every field before using it.</p>
          {!lastResult ? (
            <p>The fields will appear here after your first answer.</p>
          ) : (
            <>
              <p className="builder-preview-count">
                {lastResult.response.proposals.length} of 12 fields proposed
              </p>
              <div className="builder-preview-fields">
                {lastResult.response.proposals.map((proposal) => (
                  <details
                    key={proposal.field}
                    open={proposal.field === 'title' || proposal.field === 'problem'}
                  >
                    <summary>{fieldLabels[proposal.field]}</summary>
                    <p>{proposal.text}</p>
                    <details className="builder-evidence">
                      <summary>From your answers</summary>
                      {proposal.evidence.map((evidence, index) => (
                        <blockquote key={index}>{evidence.quote}</blockquote>
                      ))}
                    </details>
                  </details>
                ))}
              </div>
              {missing.length > 0 && (
                <p className="small">
                  <strong>Still missing:</strong>{' '}
                  {missing.map((field) => fieldLabels[field]).join(', ')}. You can finish these in
                  the form.
                </p>
              )}
              <label className="checkbox-label builder-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={pending || !!failed}
                />
                I have checked the proposed fields and want to use them in the form.
              </label>
              <button
                className="button primary"
                disabled={
                  !confirmed ||
                  pending ||
                  !!text.trim() ||
                  !!failed ||
                  !fields ||
                  !lastResult.response.proposals.length
                }
                onClick={() => {
                  if (fields) onApply(fields);
                }}
              >
                <Check size={16} aria-hidden="true" />
                Use draft in form
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </>
          )}
          <p className="small">
            The conversation stays on this page and is not shown to reviewers. Server response
            receipts expire after 24 hours and are removed on a later turn or scheduled cleanup.
          </p>
        </aside>
      </div>
      <div className="builder-footer">
        <button
          className="text-button"
          disabled={pending}
          onClick={() => {
            if (
              (!turns.length && !text) ||
              window.confirm(
                'Switch to the form? This conversation and proposed preview will be cleared from this page.',
              )
            )
              onManual();
          }}
        >
          Fill the form manually
        </button>
        <span className="small">
          Requirements you enter are sent to Gemini. Files and linked pages are not read.
        </span>
      </div>
      <ConfirmDialog
        open={restart}
        onOpenChange={setRestart}
        title="Start a new draft conversation?"
        description="This removes the conversation and proposed preview from this page. No saved request is deleted."
      >
        <div className="dialog-actions">
          <button className="button" onClick={() => setRestart(false)}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={() => {
              setTurns([]);
              setText('');
              setError(null);
              setFailed(null);
              setConfirmed(false);
              setRestart(false);
            }}
          >
            Start again
          </button>
        </div>
      </ConfirmDialog>
    </section>
  );
}
