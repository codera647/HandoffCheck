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
import type {
  AutomationPolicy,
  PolicyInput,
  AutomationTask,
  TaskKind,
  InAppNotification,
} from '../../shared/automation';
import type { LinearConnection, LinearTeams, TicketPreview } from '../../shared/linear';
import type { IntakeInput, IntakeResult } from '../../shared/intake';

export interface Repository {
  mode: 'demo' | 'supabase';
  context(): Promise<AppContext>;
  list(filters: ListFilters): Promise<RequestPage>;
  get(id: string): Promise<RequestRecord>;
  create(draft: DraftInput, key: string): Promise<RequestRecord>;
  intake(input: IntakeInput, key: string): Promise<IntakeResult>;
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
  automationPolicy(): Promise<AutomationPolicy>;
  saveAutomationPolicy(input: PolicyInput): Promise<void>;
  testAIProvider(): Promise<{ verified: boolean; model: string }>;
  assistance(id: string): Promise<AutomationTask[]>;
  requestAssistance(
    id: string,
    kind: TaskKind,
    revision: number,
    briefId: string | null,
  ): Promise<void>;
  acceptEdit(taskId: string, index: number, revision: number): Promise<RequestRecord>;
  reviewQA(taskId: string): Promise<void>;
  notifications(): Promise<InAppNotification[]>;
  readNotification(id: string): Promise<void>;
  linearConnection(): Promise<LinearConnection>;
  linearTeams(): Promise<LinearTeams>;
  saveLinearTeam(teamId: string, organizationId: string, expectedVersion: number): Promise<void>;
  ticketPreview(briefId: string): Promise<TicketPreview>;
  createTicket(briefId: string, payloadHash: string): Promise<TicketPreview>;
}
