import { z } from 'zod';
import type { AutomationTask } from '../../shared/automation';

const savedHistorySchema = z.array(z.tuple([z.string(), z.string()]));
export type ChatVisibility = { hidden: Map<string, string>; error: Error | null };
export function readChatVisibility(key: string): ChatVisibility {
  try {
    const saved = localStorage.getItem(key);
    return {
      hidden: new Map(saved ? savedHistorySchema.parse(JSON.parse(saved)) : []),
      error: null,
    };
  } catch {
    return {
      hidden: new Map(),
      error: new Error(
        'Your saved chat view could not be loaded. Messages are shown so you can still read them.',
      ),
    };
  }
}
export function saveChatVisibility(key: string, hidden: Map<string, string>): ChatVisibility {
  try {
    if (hidden.size) localStorage.setItem(key, JSON.stringify([...hidden]));
    else localStorage.removeItem(key);
    return { hidden, error: null };
  } catch {
    throw new Error(
      'This browser could not save the chat view. Your current view has not changed.',
    );
  }
}
export function activitySignature(task: AutomationTask): string {
  return ['queued', 'working'].includes(task.state) ? `${task.state}:${task.attempts}` : 'hidden';
}
export function activityVisibilityId(task: AutomationTask): string {
  return task.kind === 'review' && task.reviewId ? `review:${task.reviewId}` : task.id;
}
export function isActivityHidden(task: AutomationTask, hidden: Map<string, string>): boolean {
  const signature = hidden.get(activityVisibilityId(task));
  return signature === 'hidden' || signature === `${task.state}:${task.attempts}`;
}
