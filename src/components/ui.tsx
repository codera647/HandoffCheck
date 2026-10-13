import * as Dialog from '@radix-ui/react-dialog';
import { X, AlertCircle, FileText, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { statusLabels } from '../../shared/domain';
import type { Status } from '../../shared/contracts';

export function StatusBadge({ status, archived = false }: { status: Status; archived?: boolean }) {
  const kind = archived
    ? 'neutral'
    : status === 'review_error'
      ? 'danger'
      : ['approved', 'brief_ready'].includes(status)
        ? 'success'
        : ['needs_clarification', 'partially_approved', 'ready_for_approval'].includes(status)
          ? 'attention'
          : 'neutral';
  return (
    <span className={`badge ${kind}`}>
      <span className="status-dot" aria-hidden="true" />
      {archived ? 'Archived' : statusLabels[status]}
    </span>
  );
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'The action could not be completed.';
  return (
    <div className="notice danger" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        {message}
        {retry && (
          <button className="text-button" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <FileText size={26} strokeWidth={1.5} aria-hidden="true" />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-busy="true">
      {label}
    </div>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          <Dialog.Close className="icon-button dialog-close" aria-label="Close dialog">
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Success({ children }: { children: ReactNode }) {
  return (
    <p className="success-message" role="status">
      <Check size={16} aria-hidden="true" />
      {children}
    </p>
  );
}
export function formatDate(value: string, timezone = 'Asia/Karachi'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
export function formatBytes(value: number): string {
  return value < 1000000 ? `${Math.round(value / 1000)} KB` : `${(value / 1000000).toFixed(1)} MB`;
}
