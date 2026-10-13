import type {
  AppContext,
  Command,
  DraftInput,
  FileMeta,
  ListFilters,
  RequestPage,
  RequestRecord,
  Role,
} from '../../shared/contracts';
import type { GoogleDocument, WorkspaceConnection } from '../../shared/workspace-bridge';

export interface Repository {
  mode: 'demo' | 'supabase';
  context(): Promise<AppContext>;
  list(filters: ListFilters): Promise<RequestPage>;
  get(id: string): Promise<RequestRecord>;
  create(draft: DraftInput, key: string): Promise<RequestRecord>;
  command(id: string, command: Command, key: string): Promise<RequestRecord>;
  upload(id: string, file: File): Promise<FileMeta>;
  download(id: string): Promise<{ url: string; name: string; revoke?: () => void }>;
  invite(email: string, role: Role): Promise<void>;
  changeMember(id: string, role: Role, status: 'active' | 'revoked'): Promise<void>;
  publishChecklist(name: string): Promise<void>;
  workspaceConnection(): Promise<WorkspaceConnection>;
  setWorkspaceEnabled(enabled: boolean): Promise<void>;
  googleDocument(briefId: string): Promise<GoogleDocument>;
  signOut(): Promise<void>;
}
