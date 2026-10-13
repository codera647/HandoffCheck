import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { demoMembers, demoRepository } from '../lib/demo';
import {
  acceptMembership,
  demoEnabled,
  hostedRepository,
  restoreHostedSession,
  startGoogleLogin,
  supabase,
} from '../lib/supabase';
import type { Repository } from '../lib/repository';
import type { AppContext } from '../../shared/contracts';

interface Session {
  repository: Repository | null;
  context?: AppContext;
  loading: boolean;
  error: Error | null;
  enterDemo(id?: string): void;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
  signInWithGoogle(): Promise<void>;
}
const SessionContext = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const queries = useQueryClient();
  const [demoId, setDemoId] = useState<string | null>(() =>
    demoEnabled && location.pathname !== '/auth/callback'
      ? localStorage.getItem('handoffcheck-demo-user')
      : null,
  );
  const [hostedId, setHostedId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(!!supabase && !demoId);
  const [authError, setAuthError] = useState<Error | null>(null);
  useEffect(() => {
    if (!supabase || demoId) {
      setAuthLoading(false);
      return;
    }
    let live = true;
    let restored = false;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live) {
        setHostedId(session?.user.id ?? null);
        if (restored) setAuthLoading(false);
      }
    });
    setAuthLoading(true);
    if (location.pathname === '/auth/callback') localStorage.removeItem('handoffcheck-demo-user');
    restoreHostedSession()
      .then((session) => {
        if (live) {
          restored = true;
          setHostedId(session?.user.id ?? null);
          setAuthLoading(false);
          setAuthError(null);
        }
      })
      .catch((error: unknown) => {
        if (live) {
          restored = true;
          setHostedId(null);
          setAuthLoading(false);
          setAuthError(
            error instanceof Error ? error : new Error('Google sign-in could not be completed.'),
          );
        }
      });
    return () => {
      live = false;
      subscription.unsubscribe();
    };
  }, [demoId]);
  const repository = useMemo(
    () => (demoId ? demoRepository(demoId) : hostedId ? hostedRepository : null),
    [demoId, hostedId],
  );
  const contextQuery = useQuery({
    queryKey: ['context', demoId, hostedId],
    enabled: !!repository,
    queryFn: async () => {
      if (!repository) throw new Error('Sign in to continue.');
      if (repository.mode === 'supabase') await acceptMembership();
      return repository.context();
    },
    refetchOnWindowFocus: true,
  });
  const value: Session = {
    repository,
    context: contextQuery.data,
    loading: authLoading || (!!repository && contextQuery.isPending),
    error: authError || contextQuery.error,
    enterDemo(id = demoMembers[0].id) {
      if (!demoEnabled) return;
      localStorage.setItem('handoffcheck-demo-user', id);
      queries.clear();
      setAuthError(null);
      setDemoId(id);
    },
    async refresh() {
      await contextQuery.refetch();
    },
    async signInWithGoogle() {
      setAuthError(null);
      await startGoogleLogin();
      localStorage.removeItem('handoffcheck-demo-user');
      setDemoId(null);
      queries.clear();
    },
    async signOut() {
      await repository?.signOut();
      localStorage.removeItem('handoffcheck-demo-user');
      setDemoId(null);
      setHostedId(null);
      setAuthError(null);
      queries.clear();
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider is required.');
  return ctx;
}
export function useWorkspace(): { repository: Repository; context: AppContext } {
  const session = useSession();
  if (!session.repository || !session.context) throw new Error('Workspace is not ready.');
  return { repository: session.repository, context: session.context };
}
