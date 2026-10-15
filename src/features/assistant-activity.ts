import type { RequestRecord } from '../../shared/contracts';
import type { AutomationTask } from '../../shared/automation';

export type AssistantActivity = AutomationTask & { origin: 'job' | 'review' };
export function reviewForActivity(record: RequestRecord, task: AutomationTask) {
  return task.kind === 'review'
    ? record.reviews.find(
        (review) =>
          review.id ===
          (task.reviewId ?? (task.id === record.reviewTask?.id ? record.currentReviewId : null)),
      )
    : undefined;
}
// Reviews without an automation job (including checklist reviews) still have real saved responses.
export function assistantActivities(
  record: RequestRecord,
  tasks: AutomationTask[],
  demo: boolean,
): AssistantActivity[] {
  const linked = new Set(tasks.map((task) => task.reviewId).filter(Boolean));
  return [
    ...tasks.map((task) => ({ ...task, origin: 'job' as const })),
    ...record.reviews
      .filter((review) => !linked.has(review.id))
      .map((review) => {
        const current = record.reviewTask?.reviewId === review.id ? record.reviewTask : null;
        return {
          id: `review:${review.id}`,
          reviewId: review.id,
          requestId: record.id,
          actorId: '',
          kind: 'review' as const,
          revision: review.revision,
          inputHash: review.inputHash,
          briefId: null,
          state:
            current?.state ??
            (review.state === 'running'
              ? ('working' as const)
              : review.state === 'succeeded'
                ? ('ready' as const)
                : review.state === 'error'
                  ? ('failed' as const)
                  : ('outdated' as const)),
          output: null,
          error: current?.error ?? review.error ?? null,
          attempts: current?.attempts ?? 0,
          createdAt: review.createdAt,
          accepted: [],
          reviewedBy: null,
          demo,
          model: review.modelId ?? null,
          origin: 'review' as const,
        };
      }),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
