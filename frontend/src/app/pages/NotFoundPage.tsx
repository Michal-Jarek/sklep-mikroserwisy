import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <section className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-semibold">Nie znaleziono strony</h1>
      <p className="mt-2 text-muted-foreground">Sprawdź adres albo wróć do sklepu.</p>
      <Button asChild className="mt-6">
        <Link to="/">Wróć do sklepu</Link>
      </Button>
    </section>
  );
}
