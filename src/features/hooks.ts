import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '../app/session';
import type { Command } from '../../shared/contracts';

export function useRequest(id: string | undefined) {
  const { repository, context } = useWorkspace();
  return useQuery({
    queryKey: ['request', repository.mode, context.currentUser.id, id],
    enabled: !!id,
    queryFn: () => repository.get(id!),
    refetchInterval: (query) => (query.state.data?.status === 'reviewing' ? 3000 : false),
  });
}
export function useCommand(id: string) {
  const { repository, context } = useWorkspace(),
    queries = useQueryClient();
  return useMutation({
    mutationFn: ({ command, key }: { command: Command; key: string }) =>
      repository.command(id, command, key),
    onSuccess: (record) => {
      queries.setQueryData(['request', repository.mode, context.currentUser.id, id], record);
      void queries.invalidateQueries({ queryKey: ['requests'] });
      void queries.invalidateQueries({ queryKey: ['context'] });
    },
  });
}
