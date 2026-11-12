import { CircleAlertIcon } from 'lucide-react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { ErrorAlert } from '@/components/ErrorAlert';
import { NotFoundPage } from '@/app/pages/NotFoundPage';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageLoadError } from '@/lib/lazy-page';

/** Error boundary of a route: an error of one page does not take down the layout. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  // The chunk of a lazy page is gone (new deployment) or did not download: only a reload helps.
  if (error instanceof PageLoadError) {
    return (
      <section className="mx-auto max-w-lg py-16">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>
            <p>Nie udało się wczytać strony. Odśwież stronę.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
              Odśwież stronę
            </Button>
          </AlertDescription>
        </Alert>
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-lg py-16">
      <h1 className="mb-4 text-2xl font-semibold">Coś poszło nie tak</h1>
      <ErrorAlert error={error} onRetry={() => window.location.reload()} />
    </section>
  );
}
