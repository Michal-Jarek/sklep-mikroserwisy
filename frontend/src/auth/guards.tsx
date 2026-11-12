// Route guards for the UI only; the Gateway enforces access (wytyczne 3.6).
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { ForbiddenPage } from '@/app/pages/ForbiddenPage';
import { PageLoading } from '@/components/PageLoading';
import { loginPath, safeReturnTo, useSession } from '@/auth/session';

/** Anonymous visitor → `/login?returnTo=<this page>`. */
function useLoginRedirect() {
  const location = useLocation();
  return loginPath(location.pathname + location.search);
}

export function RequireAuth() {
  const session = useSession();
  const loginTarget = useLoginRedirect();
  if (session.status === 'loading') return <PageLoading />;
  if (session.status === 'anonymous') {
    // The session expired during a request: the layout goes to the login page with the message.
    if (session.expiredRedirect) return null;
    return <Navigate to={loginTarget} replace />;
  }
  return <Outlet />;
}

/** /admin/*: anonymous → login; logged in without ADMIN → "Brak dostępu" on the same address. */
export function RequireAdmin() {
  const session = useSession();
  const loginTarget = useLoginRedirect();
  if (session.status === 'loading') return <PageLoading />;
  if (session.status === 'anonymous') {
    if (session.expiredRedirect) return null;
    return <Navigate to={loginTarget} replace />;
  }
  if (!session.roles.includes('ADMIN')) return <ForbiddenPage />;
  return <Outlet />;
}

/** /login, /register: a logged-in user goes to `returnTo` (only a local path) or `/`. */
export function AnonymousOnly() {
  const session = useSession();
  const [searchParams] = useSearchParams();
  if (session.status === 'loading') return <PageLoading />;
  if (session.status === 'authenticated') return <Navigate to={safeReturnTo(searchParams.get('returnTo'))} replace />;
  return <Outlet />;
}
