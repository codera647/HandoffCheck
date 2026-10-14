import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { ConfirmDialog, ErrorNotice, Loading, Success } from '../components/ui';

export function LinearSettings() {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient();
  const [teamId, setTeamId] = useState(''),
    [confirm, setConfirm] = useState<{
      teamId: string;
      teamName: string;
      organizationId: string;
      organizationName: string;
      version: number;
    } | null>(null),
    [message, setMessage] = useState('');
  const connection = useQuery({
    queryKey: ['linear-connection', repository.mode, context.workspace.id],
    queryFn: () => repository.linearConnection(),
  });
  const teams = useQuery({
    queryKey: ['linear-teams', repository.mode, context.workspace.id],
    queryFn: () => repository.linearTeams(),
    enabled: false,
    retry: false,
  });
  const candidate = teams.data?.teams.find((t) => t.id === teamId);
  const mutation = useMutation({
    mutationFn: () =>
      repository.saveLinearTeam(confirm!.teamId, confirm!.organizationId, confirm!.version),
    onSuccess: async () => {
      setConfirm(null);
      setMessage('Linear destination saved. Each brief still needs a separate send confirmation.');
      await queries.invalidateQueries({ queryKey: ['linear-connection'] });
    },
  });
  if (connection.isPending) return <Loading />;
  if (connection.error || !connection.data)
    return <ErrorNotice error={connection.error} retry={() => void connection.refetch()} />;
  return (
    <section className="settings-section">
      <h2>Linear destination</h2>
      <p>
        Send an approved implementation brief to one selected team. The author or assigned lead
        previews the full ticket before creating it.
      </p>
      <p className="notice">
        {connection.data.demo
          ? 'The local demo does not contact Linear.'
          : connection.data.configured
            ? 'A backend key is configured. Load teams to verify its accessible destination.'
            : 'Setup pending. Save LINEAR_API_KEY in Supabase Edge Function secrets, then reload this page. Keep the key out of chat and frontend settings.'}
      </p>
      {connection.data.teamName && (
        <p>
          Saved destination:{' '}
          <strong>
            {connection.data.organizationName} / {connection.data.teamName}
          </strong>
        </p>
      )}
      <ErrorNotice error={teams.error} />
      <ErrorNotice error={mutation.error} />
      {message && <Success>{message}</Success>}
      <button
        className="button"
        disabled={!connection.data.configured || teams.isFetching || mutation.isPending}
        onClick={() => void teams.refetch()}
      >
        {teams.isFetching ? 'Loading teams…' : 'Load accessible teams'}
      </button>
      {teams.data && (
        <form
          className="checklist-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (candidate && teams.data)
              setConfirm({
                teamId: candidate.id,
                teamName: candidate.name,
                organizationId: teams.data.organization.id,
                organizationName: teams.data.organization.name,
                version: connection.data.version,
              });
          }}
        >
          <label htmlFor="linear-team">Team in {teams.data.organization.name}</label>
          <select
            id="linear-team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            disabled={mutation.isPending}
          >
            <option value="">Select a team</option>
            {teams.data.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
          {!teams.data.teams.length && (
            <p>No teams are accessible to this key. Check its team permissions.</p>
          )}
          <button className="button primary" disabled={!candidate || mutation.isPending}>
            Save destination
          </button>
        </form>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setConfirm(null);
        }}
        title="Save Linear destination"
        description={`New handoffs will use ${confirm?.organizationName || ''} / ${confirm?.teamName || ''}. Existing handoffs keep their original destination.`}
      >
        <ErrorNotice error={mutation.error} />
        <div className="dialog-actions">
          <button className="button" disabled={mutation.isPending} onClick={() => setConfirm(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !confirm}
            onClick={() => mutation.mutate()}
          >
            Confirm destination
          </button>
        </div>
      </ConfirmDialog>
    </section>
  );
}
