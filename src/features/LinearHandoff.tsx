import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { ConfirmDialog, ErrorNotice, Loading } from '../components/ui';
import type { Brief, RequestRecord } from '../../shared/contracts';
import type { TicketPreview } from '../../shared/linear';

export function LinearHandoff({ record, brief }: { record: RequestRecord; brief: Brief }) {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient();
  const [candidate, setCandidate] = useState<TicketPreview | null>(null);
  const key = ['linear-ticket', repository.mode, context.workspace.id, brief.id];
  const connection = useQuery({
    queryKey: ['linear-connection', repository.mode, context.workspace.id],
    queryFn: () => repository.linearConnection(),
  });
  const preview = useQuery({
    queryKey: key,
    queryFn: () => repository.ticketPreview(brief.id),
    enabled: !!connection.data?.teamId,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'creating' ? 5000 : false),
  });
  const source = record.revisions.find((v) => v.number === brief.revision),
    actor = context.currentUser;
  const canSend =
    !record.archived &&
    record.currentRevision === brief.revision &&
    (actor.id === record.authorId ||
      (actor.role === 'product_lead' && actor.id === source?.productReviewerId) ||
      (actor.role === 'engineering_lead' && actor.id === source?.engineeringReviewerId));
  const mutation = useMutation({
    mutationFn: (value: TicketPreview) => repository.createTicket(value.briefId, value.payloadHash),
    onSuccess: async (value) => {
      queries.setQueryData(key, value);
      setCandidate(null);
      await queries.invalidateQueries({ queryKey: ['request'] });
    },
    onError: () => void queries.invalidateQueries({ queryKey: key }),
  });
  return (
    <section className="assistance-section">
      <h2>Engineering ticket</h2>
      {connection.isPending ? (
        <Loading />
      ) : connection.error ? (
        <ErrorNotice error={connection.error} retry={() => void connection.refetch()} />
      ) : !connection.data?.configured || !connection.data.teamId ? (
        <p className="small">
          {connection.data?.demo
            ? 'The local demo does not send tickets to Linear.'
            : 'Linear setup is pending. An administrator must configure its key and team in Settings → Linear.'}
        </p>
      ) : (
        <>
          <ErrorNotice error={preview.error} retry={() => void preview.refetch()} />
          {preview.data?.state === 'created' && preview.data.issueUrl ? (
            <p>
              Created{' '}
              <a href={preview.data.issueUrl} target="_blank" rel="noreferrer">
                {preview.data.issueIdentifier}
              </a>{' '}
              in {preview.data.organizationName} / {preview.data.teamName}.
            </p>
          ) : (
            <>
              <p>Preview the approved revision {brief.revision} and destination before sending.</p>
              {preview.data?.error && <p className="notice attention">{preview.data.error}</p>}
              <button
                className="button"
                disabled={
                  !canSend ||
                  !preview.data ||
                  preview.data.state === 'creating' ||
                  mutation.isPending
                }
                onClick={() => {
                  mutation.reset();
                  setCandidate(preview.data!);
                }}
              >
                {preview.data?.state === 'creating' ? 'Creating ticket…' : 'Preview Linear ticket'}
              </button>
              {!canSend && (
                <p className="small">
                  Only the author or assigned leads can send the current approved brief.
                </p>
              )}
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!candidate}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setCandidate(null);
        }}
        title="Create Linear ticket"
        description="This sends the exact title and description below to the selected Linear team. Supporting uploads remain private in HandoffCheck."
      >
        {candidate && (
          <>
            <p>
              <strong>
                {candidate.organizationName} / {candidate.teamName}
              </strong>{' '}
              · Approved revision {candidate.revision}
            </p>
            <label htmlFor="ticket-title">Title</label>
            <input id="ticket-title" readOnly value={candidate.title} />
            <label htmlFor="ticket-description">Description (Markdown)</label>
            <textarea id="ticket-description" readOnly rows={12} value={candidate.description} />
            <ErrorNotice error={mutation.error} />
            <div className="dialog-actions">
              <button
                className="button"
                disabled={mutation.isPending}
                onClick={() => setCandidate(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate(candidate)}
              >
                {mutation.isPending ? 'Sending…' : 'Confirm and create ticket'}
              </button>
            </div>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}
