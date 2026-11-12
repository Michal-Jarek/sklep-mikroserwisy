import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { startSession, useSession } from '@/auth/session';

/** Starts the session once (one refresh, also under StrictMode) and drops cached data and mutations when the user changes. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { status, userId } = useSession();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    void startSession();
  }, []);

  useEffect(() => {
    if (status === 'loading') return;
    // Login, logout (also in another tab) or a different account: data of the previous user must not stay,
    // neither cached responses nor mutation variables (password, card number; C5).
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      void queryClient.resetQueries();
      queryClient.getMutationCache().clear();
    }
    previousUserId.current = userId;
  }, [status, userId, queryClient]);

  return children;
}
