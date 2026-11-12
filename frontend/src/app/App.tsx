import { useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { Providers } from '@/app/providers';
import { createAppRouter } from '@/app/router';
import { createQueryClient } from '@/api/query-client';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  return (
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  );
}
