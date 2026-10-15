import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, ArrowRight } from 'lucide-react';
import { useWorkspace } from '../app/session';
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  StatusBadge,
  formatDate,
} from '../components/ui';
import { statusLabels } from '../../shared/domain';
import type { Status } from '../../shared/contracts';

export function RequestList({ assigned = false }: { assigned?: boolean }) {
  const { repository, context } = useWorkspace(),
    [params, setParams] = useSearchParams(),
    [search, setSearch] = useState(params.get('q') || '');
  useEffect(() => {
    setSearch(params.get('q') || '');
  }, [params]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== (params.get('q') || '')) {
        const next = new URLSearchParams(params);
        search ? next.set('q', search) : next.delete('q');
        next.delete('page');
        setParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [search, params, setParams]);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const filters = {
    search: params.get('q') || '',
    status: params.get('status') || '',
    author: params.get('owner') || '',
    assigned: assigned ? context.currentUser.id : params.get('assigned') || '',
    archived: params.get('archived') === 'true',
    page,
  };
  const query = useQuery({
    queryKey: ['requests', repository.mode, context.currentUser.id, filters],
    queryFn: () => repository.list(filters),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'reviewing') ? 3000 : false,
  });
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    next.delete('page');
    setParams(next);
  }
  const name = (id: string) => context.members.find((m) => m.id === id)?.name || 'Not assigned';
  return (
    <>
      <PageHeader
        title={assigned ? 'My reviews' : 'Requests'}
        description={
          assigned
            ? 'Feature requests assigned to your approval stage.'
            : 'Keep the requirements and the review decisions in one place.'
        }
        actions={
          <Link className="button primary" to="/requests/new">
            <Plus size={17} />
            New feature request
          </Link>
        }
      />
      <div className="list-toolbar">
        <label className="search-field">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="Search title or ID"
            placeholder="Search title or ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="filter-field">
          <span className="sr-only">Status</span>
          <select
            aria-label="Filter status"
            value={filters.status}
            onChange={(e) => filter('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Filter author"
          value={filters.author}
          onChange={(e) => filter('owner', e.target.value)}
        >
          <option value="">All authors</option>
          {context.members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={filters.archived}
            onChange={(e) => filter('archived', e.target.checked ? 'true' : '')}
          />
          Archived
        </label>
      </div>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <Loading label="Loading requests…" />
      ) : (
        query.data &&
        (query.data.items.length ? (
          <>
            <div className="table-container">
              <table className="request-table">
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Status</th>
                    <th className="hide-mobile" scope="col">
                      Author
                    </th>
                    <th className="hide-tablet" scope="col">
                      Reviewers
                    </th>
                    <th className="hide-mobile" scope="col" aria-sort="descending">
                      Updated ↓
                    </th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <span className="request-id">HC-{String(r.number).padStart(4, '0')}</span>
                        <Link
                          className="request-title"
                          to={`/requests/${r.id}${assigned ? '?tab=approvals' : ''}`}
                        >
                          {r.title}
                        </Link>
                        <span className="row-meta">
                          Revision {r.currentRevision}
                          {r.blockingCount > 0 ? ` · ${r.blockingCount} blocking questions` : ''}
                        </span>
                      </td>
                      <td>
                        <StatusBadge
                          status={r.status as Status}
                          archived={r.archived}
                          reviewTask={r.reviewTask}
                        />
                      </td>
                      <td className="hide-mobile">{name(r.authorId)}</td>
                      <td className="hide-tablet">
                        <span className="reviewer-line">
                          P <span>{name(r.productReviewerId)}</span>
                        </span>
                        <span className="reviewer-line">
                          E <span>{name(r.engineeringReviewerId)}</span>
                        </span>
                      </td>
                      <td className="hide-mobile small">
                        {formatDate(r.updatedAt, context.workspace.timezone)}
                      </td>
                      <td>
                        <Link
                          className="icon-link"
                          aria-label={`Open ${r.title}`}
                          to={`/requests/${r.id}${assigned ? '?tab=approvals' : ''}`}
                        >
                          <ArrowRight size={18} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                Showing {(page - 1) * 25 + 1}–{Math.min(page * 25, query.data.total)} of{' '}
                {query.data.total} requests
              </span>
              <div>
                <button
                  className="button small-button"
                  disabled={page <= 1}
                  onClick={() => {
                    const p = new URLSearchParams(params);
                    p.set('page', String(page - 1));
                    setParams(p);
                  }}
                >
                  Previous
                </button>
                <button
                  className="button small-button"
                  disabled={page * 25 >= query.data.total}
                  onClick={() => {
                    const p = new URLSearchParams(params);
                    p.set('page', String(page + 1));
                    setParams(p);
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            title={
              params.size || assigned
                ? 'No requests match these filters.'
                : 'No feature requests yet.'
            }
            description="Start with the problem, then describe the behavior engineering should build."
            action={
              params.size ? (
                <button className="button" onClick={() => setParams({})}>
                  Clear filters
                </button>
              ) : (
                <Link className="button primary" to="/requests/new">
                  New feature request
                </Link>
              )
            }
          />
        ))
      )}
      <p className="list-footer">
        A brief is ready only after both leads approve the same revision.
      </p>
    </>
  );
}
