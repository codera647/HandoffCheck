import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import { ErrorNotice } from '../components/ui';
export function Notifications() {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient();
  const query = useQuery({
    queryKey: ['notifications', repository.mode, context.workspace.id, context.currentUser.id],
    queryFn: () => repository.notifications(),
    refetchInterval: 60000,
  });
  const mutation = useMutation({
    mutationFn: (id: string) => repository.readNotification(id),
    onSuccess: () => queries.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <details className="notifications">
      <summary>Review reminders ({query.data?.filter((n) => !n.read).length ?? 0})</summary>
      <ErrorNotice error={query.error || mutation.error} />
      {query.data && !query.data.length && <p className="small">No review reminders.</p>}
      {query.data?.map((n) => (
        <div className="notification" key={n.id}>
          <Link to={`/requests/${n.requestId}`}>{n.title}</Link>
          {!n.read && (
            <button
              className="text-button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(n.id)}
            >
              Mark read
            </button>
          )}
        </div>
      ))}
    </details>
  );
}
