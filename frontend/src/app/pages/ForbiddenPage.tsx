import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function ForbiddenPage() {
  return (
    <section className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold">Brak dostępu</h1>
      <p className="mt-2 text-muted-foreground">Ta strona jest dostępna tylko dla administratora.</p>
      <Button asChild className="mt-6">
        <Link to="/">Wróć do sklepu</Link>
      </Button>
    </section>
  );
}
