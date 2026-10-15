import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { ErrorNotice, Loading, formatDate } from '../components/ui';

export function GoogleWorkspaceSettings() {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient();
  const query = useQuery({
    queryKey: ['workspace-connection', repository.mode, context.workspace.id],
    queryFn: () => repository.workspaceConnection(),
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => repository.setWorkspaceEnabled(enabled),
    onSuccess: () => queries.invalidateQueries({ queryKey: ['workspace-connection'] }),
  });
  if (repository.mode === 'demo')
    return (
      <section className="settings-section">
        <h2>Google Workspace</h2>
        <p>
          The demo does not connect to Google Forms, Sheets, or Docs. Sign in to the hosted
          workspace to use this connection.
        </p>
      </section>
    );
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const connection = query.data;
  return (
    <section className="settings-section">
      <h2>Google Workspace</h2>
      <p className="section-intro">
        Forms collects feature requests. Sheets tracks Form submissions. After both leads approve an
        imported request and a brief is generated, Apps Script exports it to a private Google Doc.
      </p>
      <p className="notice neutral">
        Requests created in HandoffCheck stay out of the Google tracking and export pipeline. The
        Form owner and anyone with access to the response Sheet can read Form submissions. Keep
        Google sharing restricted to the trusted operator; app permissions do not remove existing
        Google shares or Sheet rows.
      </p>
      <ErrorNotice error={mutation.error} />
      {!connection?.formId ? (
        <p>
          Setup is pending. The Google account owner must authorize Apps Script and run the setup
          function.
        </p>
      ) : (
        <>
          <dl className="settings-dl">
            <dt>Connection</dt>
            <dd>{connection.enabled ? 'Enabled' : 'Paused'}</dd>
            <dt>Last completed sync</dt>
            <dd>
              {connection.lastSyncAt
                ? formatDate(connection.lastSyncAt, context.workspace.timezone)
                : 'No completed sync yet'}
            </dd>
            <dt>Feature intake</dt>
            <dd>
              {connection.formUrl ? (
                <a href={connection.formUrl} target="_blank" rel="noreferrer">
                  Fill out intake form
                </a>
              ) : (
                <span>
                  Intake link is pending. Update the Apps Script code and run setupWorkspace to
                  register it.
                </span>
              )}
            </dd>
            <dt>Form administration</dt>
            <dd>
              <a
                href={`https://docs.google.com/forms/d/${connection.formId}/edit`}
                target="_blank"
                rel="noreferrer"
              >
                Edit intake form
              </a>
            </dd>
            <dt>Tracking</dt>
            <dd>
              <a
                href={`https://docs.google.com/spreadsheets/d/${connection.sheetId}/edit`}
                target="_blank"
                rel="noreferrer"
              >
                Open tracking Sheet
              </a>
            </dd>
            <dt>Approved briefs</dt>
            <dd>
              <a
                href={`https://drive.google.com/drive/folders/${connection.folderId}`}
                target="_blank"
                rel="noreferrer"
              >
                Open private brief folder
              </a>
            </dd>
          </dl>
          <button
            className="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(!connection.enabled)}
          >
            {mutation.isPending ? 'Saving…' : connection.enabled ? 'Pause sync' : 'Resume sync'}
          </button>
        </>
      )}
      <p className="small">
        Invited employees must sign in to HandoffCheck before their Form submissions can import.
        Assign reviewers and edit drafts in the app. Google file access follows the owner’s Drive
        permissions.
      </p>
    </section>
  );
}
