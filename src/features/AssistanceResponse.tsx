import type { ReactNode } from 'react';
import {
  fieldLabels,
  type FeatureFields,
  type FieldName,
  type Review,
} from '../../shared/contracts';
import { blockingFindings } from '../../shared/domain';
import { fieldText, type AutomationTask } from '../../shared/automation';

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
    <>
      <p className="assistant-response-intro">
        {blockingFindings(review).length
          ? `${blockingFindings(review).length} blocking ${blockingFindings(review).length === 1 ? 'question needs an answer' : 'questions need answers'} in the requirements before approval.`
          : 'No unresolved blocking questions. Both assigned leads still need to assess this revision.'}
      </p>
      <ol className="assistant-summary">
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
            <h4>{finding.question}</h4>
            <p>{finding.explanation}</p>
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
        <>
          <h4>Context the review could not assess</h4>
          <ul>
            {review.unknowns.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </>
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
    <details className="assistant-evidence">
      <summary>Source: {label}</summary>
      <blockquote>{children}</blockquote>
      <button className="text-button" onClick={viewSource}>
        View full source
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
      <>
        <p className="assistant-response-intro">
          {output.edits.length
            ? `${output.edits.length} suggested ${output.edits.length === 1 ? 'edit' : 'edits'}. Check each change against its source before accepting it.`
            : 'No requirement edits were suggested.'}
        </p>
        {output.edits.map((item, index) => (
          <section className="suggestion" key={index}>
            <h4>{fieldLabels[item.field]}</h4>
            <p>{item.reason}</p>
            <p className="suggested-text">{item.text}</p>
            <details className="assistant-evidence">
              <summary>Compare source and suggested edit</summary>
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
              </button>
            )}
          </section>
        ))}
      </>
    );
  if ('items' in output)
    return (
      <ol className="assistant-summary">
        {output.items.map((item, index) => (
          <li key={index}>
            <p>{item.text}</p>
            <Evidence
              label={fieldLabels[item.evidenceField]}
              viewSource={() => viewSource(item.evidenceField)}
            >
              {item.evidenceQuote}
            </Evidence>
          </li>
        ))}
      </ol>
    );
  return (
    <>
      <ol className="assistant-summary">
        {output.tests.map((test, index) => (
          <li key={index}>
            <h4>{test.scenario}</h4>
            <p className="small">
              {test.kind} · Acceptance criterion {test.criterionIndex + 1}
            </p>
            <Evidence
              label={`Acceptance criterion ${test.criterionIndex + 1}`}
              viewSource={() => viewSource('criteria')}
            >
              {test.criterionQuote}
            </Evidence>
            <ol>
              {test.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
            <p>
              <strong>Expected:</strong> {test.expected}
            </p>
          </li>
        ))}
      </ol>
      <p className="small">These tests have not been executed.</p>
      {task.reviewedBy ? (
        <p className="success-message">Reviewed by {reviewerName}.</p>
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
    </>
  );
}
