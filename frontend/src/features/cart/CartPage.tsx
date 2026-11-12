// Cart: items, quantity 1–999, removal, total from the API (amounts are never computed here).
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { useCart, useChangeCartItem, useRemoveCartItem } from '@/api/cart';
import type { CartItem } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const quantitySchema = z.object({
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, 'Podaj liczbę od 1 do 999.')
    .transform(Number)
    .refine((value) => value >= 1, 'Podaj liczbę od 1 do 999.'),
});

interface CartRowProps {
  item: CartItem;
  busy: boolean;
  onChange: (quantity: number) => void;
  onRemove: () => void;
}

function CartRow({ item, busy, onChange, onRemove }: CartRowProps) {
  const form = useForm<z.input<typeof quantitySchema>, unknown, z.output<typeof quantitySchema>>({
    resolver: zodResolver(quantitySchema),
    values: { quantity: String(item.quantity) },
  });
  const error = form.formState.errors.quantity?.message;
  const inputId = `quantity-${item.productId}`;

  return (
    <li className="grid gap-3 rounded-xl border p-4 sm:grid-cols-[1fr_auto_auto] sm:items-start">
      <div>
        <Link to={`/products/${item.productId}`} className="font-medium hover:underline">
          {item.name}
        </Link>
        <p className="text-sm text-muted-foreground">
          Cena: <Money amount={item.unitPrice} />
        </p>
      </div>
      <form noValidate className="grid gap-1" onSubmit={form.handleSubmit(({ quantity }) => onChange(quantity))}>
        <div className="flex items-center gap-2">
          <Input
            id={inputId}
            inputMode="numeric"
            className="w-20"
            aria-label={`Ilość: ${item.name}`}
            aria-invalid={!!error}
            aria-describedby={error ? `${inputId}-message` : undefined}
            {...form.register('quantity')}
          />
          <Button type="submit" variant="outline" size="sm" disabled={busy} aria-label={`Zmień ilość: ${item.name}`}>
            Zmień
          </Button>
        </div>
        {error && (
          <p id={`${inputId}-message`} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
      <div className="grid justify-items-end gap-1">
        <Money amount={item.subtotal} className="font-semibold" />
        <Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Usuń: ${item.name}`} onClick={onRemove}>
          Usuń
        </Button>
      </div>
    </li>
  );
}

export function CartPage() {
  const cart = useCart();
  const change = useChangeCartItem();
  const remove = useRemoveCartItem();
  const busy = change.isPending || remove.isPending;

  let content;
  if (cart.isPending) {
    content = <PageLoading label="Ładowanie koszyka" />;
  } else if (cart.isError) {
    content = <ErrorAlert error={cart.error} onRetry={() => void cart.refetch()} />;
  } else {
    const empty = cart.data.items.length === 0;
    content = (
      <>
        {change.isError && <ErrorAlert error={change.error} context="cart" />}
        {remove.isError && <ErrorAlert error={remove.error} />}
        {change.data?.inventoryChecked === false && (
          <Alert>
            <AlertDescription>Dostępność sprawdzimy przy zamówieniu</AlertDescription>
          </Alert>
        )}
        {empty ? (
          <p className="text-muted-foreground">
            Koszyk jest pusty.{' '}
            <Link to="/" className="underline">
              Przejdź do katalogu
            </Link>
          </p>
        ) : (
          <ul aria-label="Pozycje koszyka" className="grid gap-3">
            {cart.data.items.map((item) => (
              <CartRow
                key={item.productId}
                item={item}
                busy={busy}
                onChange={(quantity) => change.mutate({ productId: item.productId, quantity })}
                onRemove={() => remove.mutate(item.productId)}
              />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-end gap-4 border-t pt-4">
          <p className="text-lg">
            Suma: <Money amount={cart.data.total} currency={cart.data.currency} className="font-semibold" />
          </p>
          {empty ? (
            <Button type="button" size="lg" disabled>
              Przejdź do zamówienia
            </Button>
          ) : (
            <Button asChild size="lg">
              <Link to="/checkout">Przejdź do zamówienia</Link>
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <section className="grid max-w-4xl gap-4">
      <h1 className="text-2xl font-semibold">Koszyk</h1>
      {content}
    </section>
  );
}
