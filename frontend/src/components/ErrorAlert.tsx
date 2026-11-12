import { CircleAlertIcon } from 'lucide-react';
import { ApiError, errorMessage, type ErrorContext } from '@/api/errors';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface ErrorAlertProps {
  error: unknown;
  /** Action-specific messages (e.g. review 403/409, cart 409). */
  context?: ErrorContext;
  title?: string;
  /** Shows "Spróbuj ponownie" (e.g. `refetch` of the query). */
  onRetry?: () => void;
  className?: string;
}

/** Customer-facing message of a failed request with the request id for support. */
export function ErrorAlert({ error, context, title, onRetry, className }: ErrorAlertProps) {
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Alert variant="destructive" className={className}>
      <CircleAlertIcon />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>
        <p>{errorMessage(error, context)}</p>
        {requestId && <p className="text-xs">Kod zgłoszenia: {requestId}</p>}
        {onRetry && (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            Spróbuj ponownie
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
