// Checkout in four steps on one page: address, shipping, test payment, summary (wytyczne 3.6).
// "Do zapłaty" is the only amount computed in the frontend (grosze, decision 9); the final amount comes from Order.
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type Control } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { useCart } from '@/api/cart';
import { ApiError } from '@/api/errors';
import { useCreateOrder } from '@/api/orders';
import { useShippingMethods } from '@/api/shipping';
import type { Address, Cart, OrderDetail, ShippingMethod } from '@/api/types';
import { useAddAddress, useAddresses, useProfile } from '@/api/users';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { checkoutSchema, NEW_ADDRESS, toOrderRequest, type CheckoutInput, type CheckoutValues } from '@/features/checkout/checkout-form';
import { shortOrderId } from '@/features/orders/order-rules';
import { shippingMethodLabel } from '@/lib/labels';
import { addAmounts } from '@/lib/money';

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

function ShippingStep({ control, error }: { control: Control<CheckoutInput, unknown, CheckoutValues>; error?: string }) {
  const methods = useShippingMethods();
  if (methods.isPending) return <PageLoading label="Ładowanie sposobów dostawy" />;
  if (methods.isError) return <ErrorAlert error={methods.error} onRetry={() => void methods.refetch()} />;
  return (
    <Controller
      control={control}
      name="shippingMethod"
      render={({ field }) => (
        <>
          <RadioGroup
            aria-label="Sposób dostawy"
            aria-invalid={!!error}
            aria-describedby={error ? 'checkout-shipping-message' : undefined}
            value={field.value}
            onValueChange={field.onChange}
          >
            {methods.data.map((method, index) => (
              <div key={method.code} className="flex items-center gap-3">
                {/* field.ref on the first option: a validation error moves the focus here. */}
                <RadioGroupItem id={`shipping-${method.code}`} value={method.code} ref={index === 0 ? field.ref : undefined} />
                <Label htmlFor={`shipping-${method.code}`} className="font-normal">
                  {shippingMethodLabel(method.code, method.name)} — <Money amount={method.price} currency={method.currency} /> ({method.estimatedDays} dni)
                </Label>
              </div>
            ))}
          </RadioGroup>
          {error && (
            <p id="checkout-shipping-message" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    />
  );
}

function Summary({ cart, control }: { cart: Cart; control: Control<CheckoutInput, unknown, CheckoutValues> }) {
  const methods = useShippingMethods();
  const code = useWatch({ control, name: 'shippingMethod' });
  const method: ShippingMethod | undefined = methods.data?.find((m) => m.code === code);
  const toPay = method ? addAmounts(cart.total, method.price) : null;
  return (
    <>
      <ul aria-label="Produkty w zamówieniu" className="grid gap-1 text-sm">
        {cart.items.map((item) => (
          <li key={item.productId} className="flex justify-between gap-4">
            <span>
              {item.name} × {item.quantity}
            </span>
            <Money amount={item.subtotal} />
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-3">
        <dt>Suma</dt>
        <dd>
          <Money amount={cart.total} currency={cart.currency} />
        </dd>
        <dt>Dostawa</dt>
        <dd>{method ? <Money amount={method.price} currency={method.currency} /> : '—'}</dd>
        <dt className="text-lg font-semibold">Do zapłaty</dt>
        <dd className="text-lg font-semibold">{toPay ? <Money amount={toPay} currency={cart.currency} /> : '—'}</dd>
      </dl>
    </>
  );
}

interface CheckoutFormProps {
  cart: Cart;
  addresses: readonly Address[];
  defaults: Pick<CheckoutInput, 'firstName' | 'lastName'>;
  addressesError: unknown;
  onRetryAddresses: () => void;
}

/** Outcome of the last attempt that keeps the user on this page. */
type OrderOutcome = { failedOrder: OrderDetail } | { error: unknown } | null;

function CheckoutForm({ cart, addresses, defaults, addressesError, onRetryAddresses }: CheckoutFormProps) {
  const navigate = useNavigate();
  const createOrder = useCreateOrder();
  // Kept here and not in the mutation: the mutation is reset after every attempt, so its variables
  // (with the card number) do not stay in the MutationCache (wytyczne 3.6: the card only in the form state).
  const [outcome, setOutcome] = useState<OrderOutcome>(null);
  const addAddress = useAddAddress();
  const form = useForm<CheckoutInput, unknown, CheckoutValues>({
    resolver: zodResolver(checkoutSchema),
    defaultValues: {
      addressChoice: addresses[0]?.id ?? NEW_ADDRESS,
      ...defaults,
      street: '',
      city: '',
      postalCode: '',
      countryCode: 'PL',
      saveAddress: false,
      shippingMethod: '',
      cardNumber: '',
    },
  });
  const { errors } = form.formState;
  const addressChoice = useWatch({ control: form.control, name: 'addressChoice' });
  const busy = form.formState.isSubmitting || createOrder.isPending;

  async function onSubmit(values: CheckoutValues) {
    const request = toOrderRequest(values, addresses);
    if (!request) {
      // The chosen saved address is not on the list (it could not be reloaded): choose again from a fresh list.
      form.setError('addressChoice', { message: 'Wybierz adres dostawy.' }, { shouldFocus: true });
      onRetryAddresses();
      return;
    }
    const { order, addressToSave } = request;
    if (addressToSave) {
      try {
        const saved = await addAddress.mutateAsync(addressToSave);
        // A second attempt (e.g. after a rejected payment) uses the saved address instead of adding it again.
        form.setValue('addressChoice', saved.id);
        form.setValue('saveAddress', false);
      } catch {
        return; // addAddress.error is shown above the button
      }
    }
    setOutcome(null);
    try {
      const created = await createOrder.mutateAsync(order);
      if (created.status === 'PAID') {
        navigate(`/orders/${created.id}`, { state: { paid: true } });
        return;
      }
      setOutcome({ failedOrder: created });
      form.setValue('cardNumber', '');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CART_EMPTY') navigate('/cart');
      else setOutcome({ error });
    } finally {
      createOrder.reset();
    }
  }

  const failedOrder = outcome && 'failedOrder' in outcome ? outcome.failedOrder : null;
  const orderError = outcome && 'error' in outcome ? outcome.error : null;
  // Both are fixed in the cart: fewer pieces or removing a product withdrawn from the shop.
  const cartError = orderError instanceof ApiError && (orderError.code === 'INSUFFICIENT_STOCK' || orderError.code === 'PRODUCT_UNAVAILABLE');
  const addressError = errors.addressChoice?.message;

  return (
    <form noValidate className="grid gap-6" onSubmit={form.handleSubmit(onSubmit)}>
      <Step title="1. Adres dostawy">
        {addressesError !== null && <ErrorAlert error={addressesError} title="Nie udało się wczytać zapisanych adresów" onRetry={onRetryAddresses} />}
        <Controller
          control={form.control}
          name="addressChoice"
          render={({ field }) => (
            <RadioGroup
              aria-label="Adres dostawy"
              aria-invalid={!!addressError}
              aria-describedby={addressError ? 'checkout-address-message' : undefined}
              value={field.value}
              onValueChange={field.onChange}
            >
              {addresses.map((address, index) => (
                <div key={address.id} className="flex items-center gap-3">
                  {/* field.ref on the first option: a validation error moves the focus here. */}
                  <RadioGroupItem id={`address-${address.id}`} value={address.id} ref={index === 0 ? field.ref : undefined} />
                  <Label htmlFor={`address-${address.id}`} className="font-normal">
                    {address.street}, {address.postalCode} {address.city}, {address.countryCode}
                  </Label>
                </div>
              ))}
              <div className="flex items-center gap-3">
                <RadioGroupItem id="address-new" value={NEW_ADDRESS} ref={addresses.length === 0 ? field.ref : undefined} />
                <Label htmlFor="address-new" className="font-normal">
                  Nowy adres
                </Label>
              </div>
            </RadioGroup>
          )}
        />
        {addressError && (
          <p id="checkout-address-message" className="text-sm text-destructive">
            {addressError}
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="checkout-first-name" label="Imię" error={errors.firstName?.message}>
            <Input id="checkout-first-name" autoComplete="given-name" aria-invalid={!!errors.firstName} aria-describedby="checkout-first-name-message" {...form.register('firstName')} />
          </FormField>
          <FormField id="checkout-last-name" label="Nazwisko" error={errors.lastName?.message}>
            <Input id="checkout-last-name" autoComplete="family-name" aria-invalid={!!errors.lastName} aria-describedby="checkout-last-name-message" {...form.register('lastName')} />
          </FormField>
        </div>
        {addressChoice === NEW_ADDRESS && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="checkout-street" label="Ulica i numer" error={errors.street?.message}>
              <Input id="checkout-street" autoComplete="street-address" aria-invalid={!!errors.street} aria-describedby="checkout-street-message" {...form.register('street')} />
            </FormField>
            <FormField id="checkout-city" label="Miasto" error={errors.city?.message}>
              <Input id="checkout-city" autoComplete="address-level2" aria-invalid={!!errors.city} aria-describedby="checkout-city-message" {...form.register('city')} />
            </FormField>
            <FormField id="checkout-postal-code" label="Kod pocztowy" error={errors.postalCode?.message}>
              <Input id="checkout-postal-code" autoComplete="postal-code" aria-invalid={!!errors.postalCode} aria-describedby="checkout-postal-code-message" {...form.register('postalCode')} />
            </FormField>
            <FormField id="checkout-country" label="Kraj (kod z 2 liter)" error={errors.countryCode?.message}>
              <Input id="checkout-country" autoComplete="country" maxLength={2} aria-invalid={!!errors.countryCode} aria-describedby="checkout-country-message" {...form.register('countryCode')} />
            </FormField>
            <Controller
              control={form.control}
              name="saveAddress"
              render={({ field }) => (
                <div className="flex items-center gap-2 sm:col-span-2">
                  <Checkbox id="checkout-save-address" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                  <Label htmlFor="checkout-save-address" className="font-normal">
                    Zapisz w profilu
                  </Label>
                </div>
              )}
            />
          </div>
        )}
      </Step>

      <Step title="2. Dostawa">
        <ShippingStep control={form.control} error={errors.shippingMethod?.message} />
      </Step>

      <Step title="3. Płatność">
        <FormField id="checkout-card" label="Numer karty" error={errors.cardNumber?.message}>
          {/* Only in the form state: no autocomplete, never stored, never in the address. */}
          <Input id="checkout-card" inputMode="numeric" autoComplete="off" maxLength={30} aria-invalid={!!errors.cardNumber} aria-describedby="checkout-card-message" {...form.register('cardNumber')} />
        </FormField>
        <p className="text-sm text-muted-foreground">Płatność testowa: karta kończąca się cyfrą 0 zostanie odrzucona</p>
      </Step>

      <Step title="4. Podsumowanie">
        <Summary cart={cart} control={form.control} />
      </Step>

      {failedOrder && (
        <Alert variant="destructive">
          <AlertDescription>
            Płatność odrzucona — zamówienie nr {shortOrderId(failedOrder.id)} ma status Płatność nieudana. Możesz spróbować ponownie.
          </AlertDescription>
        </Alert>
      )}
      {addAddress.isError && <ErrorAlert error={addAddress.error} title="Nie udało się zapisać adresu" />}
      {orderError !== null && (
        <div className="grid gap-2">
          <ErrorAlert error={orderError} />
          {cartError && (
            <Link to="/cart" className="underline">
              Przejdź do koszyka
            </Link>
          )}
        </div>
      )}
      <Button type="submit" size="lg" className="justify-self-end" disabled={busy}>
        Zamawiam i płacę
      </Button>
    </form>
  );
}

export function CheckoutPage() {
  const cart = useCart();
  const profile = useProfile();
  const addresses = useAddresses();

  let content;
  if (cart.isPending || profile.isPending || addresses.isPending) {
    content = <PageLoading label="Ładowanie zamówienia" />;
  } else if (cart.isError) {
    content = <ErrorAlert error={cart.error} onRetry={() => void cart.refetch()} />;
  } else if (cart.data.items.length === 0) {
    content = (
      <p className="text-muted-foreground">
        Koszyk jest pusty.{' '}
        <Link to="/" className="underline">
          Przejdź do katalogu
        </Link>
      </p>
    );
  } else {
    // Without a profile (ADMIN, User Service down) the names are typed by hand.
    content = (
      <CheckoutForm
        cart={cart.data}
        addresses={addresses.data ?? []}
        defaults={{ firstName: profile.data?.firstName ?? '', lastName: profile.data?.lastName ?? '' }}
        addressesError={addresses.error}
        onRetryAddresses={() => void addresses.refetch()}
      />
    );
  }

  return (
    <section className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Zamówienie</h1>
      {content}
    </section>
  );
}
