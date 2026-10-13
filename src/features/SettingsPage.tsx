import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type Member, type Role } from '../../shared/contracts';
import { roleLabels } from '../../shared/domain';
import { useWorkspace } from '../app/session';
import { resetDemo } from '../lib/demo';
import {
  ConfirmDialog,
  ErrorNotice,
  PageHeader,
  Success,
  formatBytes,
  formatDate,
} from '../components/ui';
import { GoogleWorkspaceSettings } from './GoogleWorkspaceSettings';

export function SettingsPage() {
  const { tab = 'profile' } = useParams(),
    { repository, context } = useWorkspace(),
    queries = useQueryClient(),
    [email, setEmail] = useState(''),
    [role, setRole] = useState<Role>('member'),
    [name, setName] = useState(''),
    [message, setMessage] = useState(''),
    [change, setChange] = useState<{
      member: Member;
      role: Role;
      status: 'active' | 'revoked';
    } | null>(null),
    [resetOpen, setResetOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (work: () => Promise<void>) => work(),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['context'] });
      void queries.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  const admin = context.currentUser.role === 'admin';
  async function work(action: () => Promise<void>, success: string) {
    setMessage('');
    await mutation.mutateAsync(action);
    setMessage(success);
  }
  const tabs = [
    ['profile', 'Profile'],
    ...(admin
      ? [
          ['members', 'Members'],
          ['checklist', 'Checklist'],
          ['pilot', 'Pilot settings'],
          ['workspace', 'Google Workspace'],
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace membership, review configuration, and your account."
      />
      <nav className="detail-tabs" aria-label="Settings sections">
        {tabs.map(([value, label]) => (
          <Link key={value} className={tab === value ? 'selected' : ''} to={`/settings/${value}`}>
            {label}
          </Link>
        ))}
      </nav>
      <ErrorNotice error={mutation.error} />
      {message && <Success>{message}</Success>}
      {tab === 'profile' ? (
        <section className="settings-section">
          <h2>Your account</h2>
          <dl className="settings-dl">
            <dt>Name</dt>
            <dd>{context.currentUser.name}</dd>
            <dt>Role</dt>
            <dd>{roleLabels[context.currentUser.role]}</dd>
            <dt>Workspace</dt>
            <dd>{context.workspace.name}</dd>
            <dt>Timezone</dt>
            <dd>{context.workspace.timezone}</dd>
            <dt>Identity</dt>
            <dd>
              {repository.mode === 'demo' ? 'Simulated demo identity' : 'Google via Supabase Auth'}
            </dd>
          </dl>
          <p className="small">Workspace administrators manage membership and reviewer roles.</p>
        </section>
      ) : !admin ? (
        <ErrorNotice
          error={new Error('Administrator access is required for this settings section.')}
        />
      ) : tab === 'members' ? (
        <>
          <section className="settings-section">
            <h2>Members</h2>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Access</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {context.members.map((member) => (
                    <tr key={member.id}>
                      <td>{member.name}</td>
                      <td>
                        <select
                          aria-label={`Role for ${member.name}`}
                          value={member.role}
                          onChange={(e) =>
                            setChange({
                              member,
                              role: e.target.value as Role,
                              status: member.status,
                            })
                          }
                        >
                          {Object.entries(roleLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span
                          className={`badge ${member.status === 'active' ? 'success' : 'neutral'}`}
                        >
                          {member.status === 'active' ? 'Active' : 'Revoked'}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() =>
                            setChange({
                              member,
                              role: member.role,
                              status: member.status === 'active' ? 'revoked' : 'active',
                            })
                          }
                        >
                          {member.status === 'active' ? 'Revoke access' : 'Restore access'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="settings-section">
            <h2>Add an invitation</h2>
            <p className="section-intro">
              Record an invited email, then share the sign-in link through your team’s existing
              process.
            </p>
            <form
              className="invitation-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await work(
                    () => repository.invite(email, role),
                    'Invitation recorded. Share the sign-in link with this employee.',
                  );
                  setEmail('');
                } catch {
                  /* Mutation error is displayed. */
                }
              }}
            >
              <label>
                Email
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {Object.entries(roleLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="button primary" disabled={mutation.isPending}>
                <Plus size={16} />
                Record invitation
              </button>
            </form>
            {repository.mode === 'demo' && (
              <p className="small">
                Demo invitations are local records. They do not grant Google login.
              </p>
            )}
            {context.invitations?.length ? (
              <table className="invitation-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {context.invitations.map((invite) => (
                    <tr key={invite.id}>
                      <td>{invite.email}</td>
                      <td>{roleLabels[invite.role]}</td>
                      <td>
                        {invite.consumed
                          ? 'Consumed'
                          : Date.parse(invite.expiresAt) < Date.now()
                            ? 'Expired'
                            : 'Invited'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        </>
      ) : tab === 'workspace' ? (
        <GoogleWorkspaceSettings />
      ) : tab === 'checklist' ? (
        <section className="settings-section">
          <h2>{context.checklist.name}</h2>
          <p className="section-intro">
            The baseline engineering fields are required for review. Existing requests retain their
            published checklist version.
          </p>
          <ul className="checklist-list">
            {context.checklist.requiredFields.map((field) => (
              <li key={field}>
                {field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
              </li>
            ))}
          </ul>
          <p className="small">
            Published {formatDate(context.checklist.createdAt, context.workspace.timezone)}
          </p>
          <form
            className="checklist-form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await work(
                  () => repository.publishChecklist(name),
                  'Checklist version published. Existing revisions were preserved.',
                );
                setName('');
              } catch {
                /* Mutation error is displayed. */
              }
            }}
          >
            <label htmlFor="checklist-name">New version name</label>
            <input
              id="checklist-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              placeholder="Engineering handoff v2"
            />
            <p className="field-help">
              This creates a new named version of the baseline checklist. Authors can explicitly
              upgrade their next revision.
            </p>
            <button className="button primary" disabled={mutation.isPending || !name.trim()}>
              Publish checklist version
            </button>
          </form>
        </section>
      ) : (
        <section className="settings-section">
          <h2>Pilot configuration</h2>
          <dl className="settings-dl">
            <dt>Review mode</dt>
            <dd>
              {context.workspace.reviewMode === 'ai'
                ? 'AI language review and checklist'
                : 'Checklist only — AI language review is not enabled'}
            </dd>
            <dt>Stored files</dt>
            <dd>{formatBytes(context.workspace.storageBytes)} of 700 MB application budget</dd>
            <dt>Demo retention policy</dt>
            <dd>{context.workspace.retentionDays} days · operator cleanup required</dd>
            <dt>Uploads</dt>
            <dd>PNG, JPEG, PDF · 5 MB/file · no content extraction</dd>
            <dt>Environment</dt>
            <dd>
              {repository.mode === 'demo'
                ? 'Browser-local synthetic data'
                : 'Supabase hosted pilot'}
            </dd>
          </dl>
          {repository.mode === 'demo' && (
            <div className="reset-section">
              <h3>Reset demo workspace</h3>
              <p>
                Remove this browser’s demo requests, uploaded files, and invitations, then reload
                the sample dataset.
              </p>
              <button className="button" onClick={() => setResetOpen(true)}>
                Reset demo data
              </button>
            </div>
          )}
          <p className="small">
            AI secrets and provider configuration belong in backend settings. Retention cleanup is
            an operator task described in the setup guide.
          </p>
        </section>
      )}
      <ConfirmDialog
        open={!!change}
        onOpenChange={(open) => {
          if (!open) setChange(null);
        }}
        title="Change workspace membership"
        description={
          change
            ? `${change.member.name} will have ${roleLabels[change.role].toLowerCase()} role and ${change.status} access.`
            : ''
        }
      >
        <ErrorNotice error={mutation.error} />
        <div className="dialog-actions">
          <button className="button" onClick={() => setChange(null)}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending}
            onClick={async () => {
              if (change) {
                try {
                  await work(
                    () => repository.changeMember(change.member.id, change.role, change.status),
                    'Membership updated.',
                  );
                  setChange(null);
                } catch {
                  /* Keep dialog and error visible. */
                }
              }
            }}
          >
            Save membership
          </button>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset local demo data"
        description="This deletes demo requests and uploaded files in this browser. Hosted workspace data is unaffected."
      >
        <div className="dialog-actions">
          <button className="button" onClick={() => setResetOpen(false)}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={async () => {
              await work(resetDemo, 'Demo reset.');
              location.assign('/requests');
            }}
          >
            Reset demo
          </button>
        </div>
      </ConfirmDialog>
    </>
  );
}
