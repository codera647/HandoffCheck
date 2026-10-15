import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  FileText,
  Info,
  ListOrdered,
  PencilLine,
  Quote,
  Target,
  type LucideIcon,
} from 'lucide-react';
import {
  fieldLabels,
  type FeatureFields,
  type FieldName,
  type Review,
} from '../../shared/contracts';
import { blockingFindings } from '../../shared/domain';
import { fieldText, type AutomationTask } from '../../shared/automation';

function ResponseText({ children }: { children: string }) {
  return (
    <div className="assistant-prose">
      <Markdown
        skipHtml
        unwrapDisallowed
        allowedElements={[
          'p',
          'strong',
          'em',
          'code',
          'pre',
          'ul',
          'ol',
          'li',
          'br',
          'blockquote',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
        ]}
        components={{ h1: 'h6', h2: 'h6', h3: 'h6', h4: 'h6', h5: 'h6' }}
      >
        {children}
      </Markdown>
    </div>
  );
}

function ResponseLead({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="assistant-answer-lead">
      <Icon size={19} aria-hidden="true" />
      <div>
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
    </div>
  );
}

const testKinds = {
  positive: 'Positive case',
  negative: 'Negative case',
  boundary: 'Boundary case',
  permission: 'Permission check',
};

function QAScenarios({
  tests,
  viewSource,
}: {
  tests: Extract<NonNullable<AutomationTask['output']>, { tests: unknown }>['tests'];
  viewSource(field: FieldName): void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  return (
    <>
      <ResponseLead icon={ClipboardList} title="Test scenarios">
        {tests.length} {tests.length === 1 ? 'scenario' : 'scenarios'} drafted from the approved
        acceptance criteria.
      </ResponseLead>
      <div className="assistant-scenario-toolbar" aria-label="QA scenario controls">
        <span className="small">
          {expanded.size} of {tests.length} expanded
        </span>
        <div>
          <button
            className="text-button"
            disabled={expanded.size === tests.length}
            onClick={() => setExpanded(new Set(tests.map((_, i) => i)))}
          >
            Expand all
          </button>
          <button
            className="text-button"
            disabled={!expanded.size}
            onClick={() => setExpanded(new Set())}
          >
            Collapse all
          </button>
        </div>
      </div>
      <div className="assistant-scenarios">
        {tests.map((test, index) => (
          <details
            key={index}
            className="assistant-test"
            open={expanded.has(index)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((previous) => {
                if (previous.has(index) === open) return previous;
                const next = new Set(previous);
                if (open) next.add(index);
                else next.delete(index);
                return next;
              });
            }}
          >
            <summary>
              <span className="assistant-test-number" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h5 className="assistant-test-title">
                <span>{test.scenario}</span>
                <span className="assistant-test-meta">
                  <span className="badge neutral">{testKinds[test.kind]}</span>
                  <span>Acceptance criterion {test.criterionIndex + 1}</span>
                </span>
              </h5>
              <ChevronDown size={16} className="assistant-disclosure-icon" aria-hidden="true" />
            </summary>
            <div className="assistant-test-body">
              <h6 className="assistant-block-label">
                <ListOrdered size={15} aria-hidden="true" />
                Steps
              </h6>
              <ol className="assistant-test-steps">
                {test.steps.map((step, i) => (
                  <li key={i}>
                    <ResponseText>{step}</ResponseText>
                  </li>
                ))}
              </ol>
              <div className="assistant-expected">
                <h6 className="assistant-block-label">
                  <Target size={15} aria-hidden="true" />
                  Expected result
                </h6>
                <ResponseText>{test.expected}</ResponseText>
              </div>
              <Evidence
                label={`Acceptance criterion ${test.criterionIndex + 1}`}
                viewSource={() => viewSource('criteria')}
              >
                {test.criterionQuote}
              </Evidence>
            </div>
          </details>
        ))}
      </div>
    </>
  );
}

export function assistanceText(task: AutomationTask): string {
  const output = task.output;
  if (!output) return '';
  if ('edits' in output)
    return (
      output.edits
        .map(
          (edit) =>
            `${fieldLabels[edit.field]}\n${edit.text}\nReason: ${edit.reason}\nSource (${fieldLabels[edit.evidenceField]}): ${edit.evidenceQuote}`,
        )
        .join('\n\n') || 'No requirement edits were suggested.'
    );
  if ('items' in output)
    return output.items
      .map(
        (item) =>
          `${item.text}\nSource (${fieldLabels[item.evidenceField]}): ${item.evidenceQuote}`,
      )
      .join('\n\n');
  return (
    output.tests
      .map(
        (test, index) =>
          `${index + 1}. ${test.scenario} (${test.kind})\nAcceptance criterion ${test.criterionIndex + 1}: ${test.criterionQuote}\n${test.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\nExpected: ${test.expected}`,
      )
      .join('\n\n') + '\n\nThese tests have not been executed.'
  );
}
export function reviewResponseText(review: Review): string {
  return [
    `Requirement review · revision ${review.revision}`,
    `${blockingFindings(review).length} unresolved blocking questions.`,
    ...review.findings.map(
      (finding) =>
        `${finding.question}\n${finding.severity}${finding.resolution ? ' · dismissed' : ''} · ${fieldLabels[finding.field]}\n${finding.explanation}\nSource: ${finding.evidence || 'Additional source detail is needed.'}`,
    ),
    ...review.unknowns.map((item) => `Unknown: ${item}`),
  ].join('\n\n');
}
export function ReviewResponse({
  review,
  viewSource,
}: {
  review: Review;
  viewSource(field: FieldName): void;
}) {
  if (review.state !== 'succeeded' && !review.findings.length) return null;
  return (
    <div className="assistant-answer">
      <ResponseLead icon={CircleHelp} title="Review findings">
        {blockingFindings(review).length
          ? `${blockingFindings(review).length} blocking ${blockingFindings(review).length === 1 ? 'question needs an answer' : 'questions need answers'} in the requirements before approval.`
          : 'No unresolved blocking questions. Both assigned leads still need to assess this revision.'}
      </ResponseLead>
      <ol className="assistant-findings" role="list">
        {review.findings.map((finding) => (
          <li key={finding.id}>
            <span
              className={`badge ${finding.resolution ? 'neutral' : finding.severity === 'blocking' ? 'attention' : 'neutral'}`}
            >
              {finding.resolution
                ? 'Dismissed'
                : finding.severity === 'blocking'
                  ? 'Blocking question'
                  : 'Advisory'}
            </span>
            <h5>{finding.question}</h5>
            <ResponseText>{finding.explanation}</ResponseText>
            <Evidence
              label={fieldLabels[finding.field]}
              viewSource={() => viewSource(finding.field)}
            >
              {finding.evidence || 'Additional detail is needed in this source field.'}
            </Evidence>
          </li>
        ))}
      </ol>
      {!!review.unknowns.length && (
        <section className="assistant-unknowns">
          <h5 className="assistant-block-label">
            <Info size={15} aria-hidden="true" />
            Context the review could not assess
          </h5>
          <ul className="assistant-bullet-list">
            {review.unknowns.map((item, index) => (
              <li key={index}>
                <ResponseText>{item}</ResponseText>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Evidence({
  label,
  children,
  viewSource,
}: {
  label: string;
  children: ReactNode;
  viewSource(): void;
}) {
  return (
    <details className="assistant-evidence assistant-source-evidence">
      <summary>
        <Quote size={14} aria-hidden="true" />
        <span>Source: {label}</span>
        <ChevronDown size={14} className="assistant-disclosure-icon" aria-hidden="true" />
      </summary>
      <blockquote>{children}</blockquote>
      <button className="text-button" onClick={viewSource}>
        View full source
        <ArrowUpRight size={13} aria-hidden="true" />
      </button>
    </details>
  );
}

export function AssistanceResponse({
  task,
  fields,
  outdated,
  author,
  pending,
  qaReviewer,
  reviewerName,
  accept,
  reviewQA,
  viewSource,
}: {
  task: AutomationTask;
  fields: FeatureFields;
  outdated: boolean;
  author: boolean;
  pending: boolean;
  qaReviewer: boolean;
  reviewerName: string;
  accept(index: number): void;
  reviewQA(): void;
  viewSource(field: FieldName): void;
}) {
  const output = task.output;
  if (!output) return null;
  if ('edits' in output)
    return (
      <div className="assistant-answer">
        <ResponseLead icon={PencilLine} title="Proposed requirement changes">
          {output.edits.length
            ? `${output.edits.length} suggested ${output.edits.length === 1 ? 'edit' : 'edits'}. Check each change against its source before accepting it.`
            : 'No requirement edits were suggested.'}
        </ResponseLead>
        {output.edits.map((item, index) => (
          <section className="suggestion" key={index}>
            <div className="assistant-edit-heading">
              <span className="assistant-test-number" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h5>{fieldLabels[item.field]}</h5>
            </div>
            <div className="assistant-proposal">
              <h6 className="assistant-block-label">
                <PencilLine size={14} aria-hidden="true" />
                Suggested wording
              </h6>
              <ResponseText>{item.text}</ResponseText>
            </div>
            <div className="assistant-edit-reason">
              <h6 className="assistant-block-label">Why this change</h6>
              <ResponseText>{item.reason}</ResponseText>
            </div>
            <details className="assistant-evidence assistant-source-evidence">
              <summary>
                <FileText size={14} aria-hidden="true" />
                <span>Compare source and suggested edit</span>
                <ChevronDown size={14} className="assistant-disclosure-icon" aria-hidden="true" />
              </summary>
              <div className="suggestion-comparison">
                <div>
                  <strong>Saved requirement</strong>
                  <p>{fieldText(fields, item.field) || 'No value recorded'}</p>
                </div>
                <div>
                  <strong>Suggested edit</strong>
                  <p>{item.text}</p>
                </div>
              </div>
            </details>
            <Evidence
              label={fieldLabels[item.evidenceField]}
              viewSource={() => viewSource(item.evidenceField)}
            >
              {item.evidenceQuote}
            </Evidence>
            {author && (
              <button
                className="button"
                disabled={task.state !== 'ready' || outdated || pending}
                onClick={() => accept(index)}
              >
                Review and accept edit
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
          </section>
        ))}
      </div>
    );
  if ('items' in output)
    return (
      <div className="assistant-answer">
        <ResponseLead icon={FileText} title="For the reviewers">
          {output.items.length} {output.items.length === 1 ? 'point' : 'points'} grounded in the
          saved requirements.
        </ResponseLead>
        <ol className="assistant-summary" role="list">
          {output.items.map((item, index) => (
            <li key={index}>
              <span className="assistant-summary-number" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <ResponseText>{item.text}</ResponseText>
                <Evidence
                  label={fieldLabels[item.evidenceField]}
                  viewSource={() => viewSource(item.evidenceField)}
                >
                  {item.evidenceQuote}
                </Evidence>
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  return (
    <div className="assistant-answer">
      <QAScenarios tests={output.tests} viewSource={viewSource} />
      <p className="assistant-draft-note">
        <Info size={15} aria-hidden="true" />
        <span>These tests have not been executed.</span>
      </p>
      {task.reviewedBy ? (
        <p className="success-message assistant-reviewed">
          <Check size={15} aria-hidden="true" />
          Reviewed by {reviewerName}.
        </p>
      ) : (
        qaReviewer && (
          <button
            className="button"
            disabled={pending || task.state !== 'ready' || outdated}
            onClick={reviewQA}
          >
            Mark QA draft reviewed
          </button>
        )
      )}
    </div>
  );
}
