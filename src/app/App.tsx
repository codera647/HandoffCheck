import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  ClipboardList,
  FileCheck2,
  Settings2,
  LogOut,
  ArrowUpRight,
  Menu,
  X,
  ChevronRight,
} from 'lucide-react';
import { useSession, useWorkspace } from './session';
import { demoEnabled, googleLoginConfigured } from '../lib/supabase';
import { roleLabels } from '../../shared/domain';
import { ErrorNotice, Loading } from '../components/ui';
import { Notifications } from '../features/Notifications';
const RequestList = lazy(() =>
  import('../features/RequestList').then((module) => ({ default: module.RequestList })),
);
const RequestEditor = lazy(() =>
  import('../features/RequestEditor').then((module) => ({ default: module.RequestEditor })),
);
const RequestDetail = lazy(() =>
  import('../features/RequestDetail').then((module) => ({ default: module.RequestDetail })),
);
const BriefPage = lazy(() =>
  import('../features/BriefPage').then((module) => ({ default: module.BriefPage })),
);
const SettingsPage = lazy(() =>
  import('../features/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      H<span className="mark-tick">✓</span>
    </span>
  );
}
function Login() {
  const session = useSession(),
    [error, setError] = useState<unknown>(null),
    [pending, setPending] = useState(false);
  if (session.context) return <Navigate to="/requests" replace />;
  return (
    <main className="login-page">
      <div className="login-content">
        <Link to="/login" className="brand">
          <Mark />
          <span>HandoffCheck</span>
        </Link>
        <h1>Feature requests ready for engineering review</h1>
        <p>Write the requirements, resolve open questions, and record approval from both leads.</p>
        <div className="login-actions">
          <button
            className="button primary"
            disabled={pending}
            onClick={async () => {
              setError(null);
              setPending(true);
              try {
                await session.signInWithGoogle();
              } catch (e) {
                setError(e);
                setPending(false);
              }
            }}
          >
            <ArrowUpRight size={17} />
            {pending ? 'Signing you in…' : 'Continue with Google'}
          </button>
          <p className="small">
            First visit? Google creates your sign-in account. An employee invitation is still
            required to access the workspace.
          </p>
          {!googleLoginConfigured && (
            <p className="field-help">
              Google sign-in is waiting for Supabase configuration. You can use the local demo
              below.
            </p>
          )}
          <ErrorNotice error={error || session.error} />
          {demoEnabled && (
            <div className="demo-entry">
              <h2>Try the local demo</h2>
              <p>
                Use synthetic requests and switch between the author and both leads. Data stays in
                this browser.
              </p>
              <button className="button" onClick={() => session.enterDemo()}>
                Open demo workspace <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
        <p className="login-footer">Product → engineering</p>
      </div>
    </main>
  );
}
function Protected() {
  const session = useSession();
  if (session.loading) return <Loading label="Checking workspace access…" />;
  if (!session.repository) return <Navigate to="/login" replace />;
  if (session.error || !session.context)
    return (
      <main className="access-page">
        <h1>Workspace access unavailable</h1>
        <ErrorNotice
          error={session.error || new Error('Your account has no active invitation.')}
          retry={() => void session.refresh()}
        />
        <button className="button" onClick={() => void session.signOut()}>
          Sign out
        </button>
      </main>
    );
  return <Shell />;
}
function Shell() {
  const { repository, context } = useWorkspace(),
    session = useSession(),
    location = useLocation(),
    navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false),
    [logoutError, setLogoutError] = useState<unknown>(null);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 767px)');
    const update = () => {
      setNarrow(media.matches);
      setMobileOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobileOpen || !narrow) return;
    const sidebar = document.getElementById('workspace-navigation')!;
    const controls = Array.from(sidebar.querySelectorAll<HTMLElement>('a,button,select')).filter(
      (element) => element.offsetParent !== null,
    );
    controls[0]?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key === 'Tab') {
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      document.getElementById('navigation-toggle')?.focus();
    };
  }, [mobileOpen, narrow]);
  useEffect(() => {
    setMobileOpen(false);
    document.getElementById('main-content')?.focus();
  }, [location.pathname]);
  const section = location.pathname.startsWith('/settings')
    ? 'Settings'
    : location.pathname === '/reviews'
      ? 'My reviews'
      : 'Requests';
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside
        id="workspace-navigation"
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
        aria-label="Main navigation"
        role={narrow && mobileOpen ? 'dialog' : undefined}
        aria-modal={narrow && mobileOpen ? true : undefined}
        inert={narrow && !mobileOpen}
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        >
          <X size={19} />
        </button>
        <Link className="brand" to="/requests">
          <Mark />
          <span>HandoffCheck</span>
        </Link>
        <div className="workspace-label">{context.workspace.name}</div>
        <nav>
          <NavLink
            to="/requests"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <ClipboardList size={18} />
            Requests
          </NavLink>
          <NavLink
            to="/reviews"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <FileCheck2 size={18} />
            My reviews
          </NavLink>
          <NavLink
            to="/settings/profile"
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <Settings2 size={18} />
            Settings
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          {repository.mode === 'demo' && (
            <label className="demo-identity">
              Demo identity
              <select
                aria-label="Demo identity"
                value={context.currentUser.id}
                onChange={(e) => {
                  session.enterDemo(e.target.value);
                  navigate('/requests');
                }}
              >
                {context.members
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {roleLabels[m.role]}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="identity">
            <span className="avatar">
              {context.currentUser.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)}
            </span>
            <div>
              <strong>{context.currentUser.name}</strong>
              <span>{roleLabels[context.currentUser.role]}</span>
            </div>
          </div>
          <button
            className="nav-item logout"
            onClick={async () => {
              try {
                await session.signOut();
              } catch (e) {
                setLogoutError(e);
              }
            }}
          >
            <LogOut size={17} />
            Sign out
          </button>
          <ErrorNotice error={logoutError} />
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="nav-scrim"
          aria-label="Close navigation backdrop"
          tabIndex={-1}
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="app-body" inert={narrow && mobileOpen}>
        <div className="topbar">
          <button
            className="icon-button mobile-menu"
            id="navigation-toggle"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu size={20} />
          </button>
          <span>{section}</span>
          <span className="topbar-caption">Product → engineering</span>
        </div>
        {repository.mode === 'demo' && (
          <div className="demo-banner">
            <span className="status-dot" />
            Local demo · synthetic data · checklist-only review
            <span className="demo-banner-detail">
              Google login and AI are not used in this demo.
            </span>
          </div>
        )}
        <main id="main-content" tabIndex={-1} className="main-content">
          <Notifications />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
export function App() {
  const session = useSession();
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/auth/callback"
          element={
            session.loading ? (
              <Loading label="Signing you in…" />
            ) : (
              <Navigate to={session.repository ? '/requests' : '/login'} replace />
            )
          }
        />
        <Route element={<Protected />}>
          <Route path="/requests" element={<RequestList />} />
          <Route path="/reviews" element={<RequestList assigned />} />
          <Route path="/requests/new" element={<RequestEditor />} />
          <Route path="/requests/:id/edit" element={<RequestEditor />} />
          <Route path="/requests/:id" element={<RequestDetail />} />
          <Route path="/briefs/:requestId/:briefId" element={<BriefPage />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/requests" replace />} />
      </Routes>
    </Suspense>
  );
}
