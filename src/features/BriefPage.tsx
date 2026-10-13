import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import { ArrowLeft, Copy, Download, Printer } from 'lucide-react';
import { useWorkspace } from '../app/session';
import { ErrorNotice, Loading, Success, formatDate } from '../components/ui';
import { useRequest } from './hooks';
import { useQuery } from '@tanstack/react-query';

export function BriefPage() {
  const { requestId, briefId } = useParams(),
    query = useRequest(requestId),
    { context, repository } = useWorkspace(),
    [message, setMessage] = useState(''),
    [error, setError] = useState<unknown>(null),
    [showSource, setShowSource] = useState(false);
  const googleDoc = useQuery({
    queryKey: ['google-document', repository.mode, briefId],
    queryFn: () => repository.googleDocument(briefId!),
    enabled: !!briefId && !!query.data?.briefs.some((b) => b.id === briefId),
    refetchInterval: (query) =>
      repository.mode === 'supabase' && !query.state.data && !query.state.error ? 60000 : false,
  });
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorNotice error={query.error} />;
  const record = query.data,
    brief = record.briefs.find((b) => b.id === briefId);
  if (!brief) return <ErrorNotice error={new Error('This approved brief could not be found.')} />;
  return (
    <>
      <div className="brief-controls">
        <Link className="back-link" to={`/requests/${requestId}`}>
          <ArrowLeft size={16} />
          View source request
        </Link>
        <div className="header-actions">
          {googleDoc.data && (
            <a
              className="button"
              href={`https://docs.google.com/document/d/${googleDoc.data.documentId}/edit`}
              target="_blank"
              rel="noreferrer"
            >
              Open Google Doc
            </a>
          )}
          <button
            className="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(brief.markdown);
                setMessage('Markdown copied.');
                setError(null);
              } catch (e) {
                setError(e);
                setShowSource(true);
              }
            }}
          >
            <Copy size={16} />
            Copy Markdown
          </button>
          <button
            className="button primary"
            onClick={() => {
              try {
                const url = URL.createObjectURL(
                  new Blob([brief.markdown], { type: 'text/markdown;charset=utf-8' }),
                );
                const a = document.createElement('a');
                a.href = url;
                a.download = `HC-${String(record.number).padStart(4, '0')}-revision-${brief.revision}.md`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMessage('Markdown download started.');
              } catch (e) {
                setError(e);
              }
            }}
          >
            <Download size={16} />
            Download Markdown
          </button>
          <button className="icon-button" aria-label="Print brief" onClick={() => window.print()}>
            <Printer size={18} />
          </button>
        </div>
      </div>
      <ErrorNotice error={error} />
      <ErrorNotice error={googleDoc.error} />
      {message && <Success>{message}</Success>}
      {brief.revision !== record.currentRevision && (
        <div className="notice attention">
          This brief is for revision {brief.revision}. The current request is revision{' '}
          {record.currentRevision}.
        </div>
      )}
      <article className="brief-document">
        <div className="document-kicker">Approved implementation brief</div>
        <Markdown skipHtml>{brief.markdown}</Markdown>
        <footer>
          Generated {formatDate(brief.createdAt, context.workspace.timezone)} ·{' '}
          {context.workspace.timezone}
          <br />
          Artifact SHA-256: <code>{brief.contentHash}</code>
        </footer>
      </article>
      {showSource && (
        <section>
          <h2>Markdown source</h2>
          <p>Select and copy the text below.</p>
          <textarea
            aria-label="Approved Markdown source"
            readOnly
            rows={20}
            value={brief.markdown}
          />
        </section>
      )}
    </>
  );
}
