import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { Header } from '@/app/layout/Header';
import { useSession } from '@/auth/session';
import { Toaster } from '@/components/ui/sonner';

/** The session ended during a request (refresh got 401): go to the login page, which shows the message. */
function SessionExpiryRedirect() {
  const { expiredRedirect } = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (expiredRedirect) navigate(expiredRedirect);
  }, [expiredRedirect, navigate]);
  return null;
}

export function AppLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <SessionExpiryRedirect />
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <Toaster position="top-center" />
    </div>
  );
}
