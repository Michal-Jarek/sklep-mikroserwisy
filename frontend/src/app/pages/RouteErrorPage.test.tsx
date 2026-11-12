import { render, screen } from '@testing-library/react';
import { Suspense, type ComponentType } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { RouteErrorPage } from '@/app/pages/RouteErrorPage';
import { PageLoading } from '@/components/PageLoading';
import { lazyPage } from '@/lib/lazy-page';

function renderRoute(Page: ComponentType) {
  // React Router reports errors caught by the route boundary on the console.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Suspense fallback={<PageLoading />}>
          <Page />
        </Suspense>
      ),
      errorElement: <RouteErrorPage />,
    },
  ]);
  render(<RouterProvider router={router} />);
}

describe('RouteErrorPage', () => {
  it('failed chunk import of a lazy page (old /assets file after a deployment) → "refresh the page"', async () => {
    const OldChunkPage = lazyPage(
      (): Promise<{ OldChunkPage: ComponentType }> =>
        Promise.reject(new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/AdminProductsPage-old.js')),
      'OldChunkPage',
    );
    renderRoute(OldChunkPage);

    expect(await screen.findByText('Nie udało się wczytać strony. Odśwież stronę.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Odśwież stronę' })).toBeInTheDocument();
    expect(screen.queryByText('Coś poszło nie tak')).not.toBeInTheDocument();
  });

  it('other page errors keep the general message', async () => {
    function BrokenPage(): never {
      throw new Error('render failed');
    }
    renderRoute(BrokenPage);

    expect(await screen.findByText('Coś poszło nie tak')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Odśwież stronę' })).not.toBeInTheDocument();
  });
});
