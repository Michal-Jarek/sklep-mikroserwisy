import type { QueryClient } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { formatMoney } from '@/lib/money';
import { loadState, updateState } from '@/mocks/db';
import { server, setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS, SEED_IDS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

const { products } = SEED_IDS;
const money = (amount: string) => formatMoney(amount).replace(/\s/g, ' ');

async function renderAsCustomer(path: string) {
  const view = await renderApp(`/login?returnTo=${encodeURIComponent(path)}`);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.customer.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.customer.password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  await vi.waitFor(() => expect(view.router.state.location.pathname).toBe(path));
  return { ...view, user };
}

function cartWith(...items: { productId: string; name: string; unitPriceCents: number; quantity: number }[]) {
  updateState((state) => {
    state.carts[SEED_IDS.customer] = items;
  });
}

/** Card numbers in the MutationCache of the app's query client (it is created by renderApp). */
function cardNumbersInMutationCache(client: QueryClient): string[] {
  return client
    .getMutationCache()
    .getAll()
    .map((mutation) => JSON.stringify(mutation.state.variables ?? null))
    .filter((variables) => variables.includes('cardNumber'));
}

/** Keeps the query client created by renderApp, to look into its caches. */
function captureQueryClient(): () => QueryClient {
  let client: QueryClient | undefined;
  vi.doMock('@/api/query-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/api/query-client')>();
    return { ...actual, createQueryClient: () => (client = actual.createQueryClient()) };
  });
  return () => client!;
}

const MUG = { productId: products.regular, name: 'Kubek ceramiczny', unitPriceCents: 1999, quantity: 2 };

async function placeOrder(user: ReturnType<typeof userEvent.setup>, cardNumber: string) {
  await user.click(await screen.findByLabelText(/^Kurier/));
  await user.type(screen.getByLabelText('Numer karty'), cardNumber);
  await user.click(screen.getByRole('button', { name: 'Zamawiam i płacę' }));
}

describe('checkout page', () => {
  it('summary: "Do zapłaty" = cart total + shipping (in grosze)', async () => {
    cartWith(MUG);
    const { user } = await renderAsCustomer('/checkout');

    // Names and the saved address from the profile.
    expect(await screen.findByLabelText('Imię')).toHaveValue('Jan');
    expect(screen.getByLabelText('ul. Testowa 1, 00-001 Warszawa, PL')).toBeChecked();
    expect(screen.getByText('Płatność testowa: karta kończąca się cyfrą 0 zostanie odrzucona')).toBeInTheDocument();

    const summary = screen.getByText('Do zapłaty').closest('dl') as HTMLElement;
    expect(summary).toHaveTextContent(`Suma${money('39.98')}`);
    await user.click(await screen.findByLabelText(/^Kurier/));
    expect(summary).toHaveTextContent(`Do zapłaty${money('54.97')}`);
    await user.click(screen.getByLabelText(/^Odbiór osobisty/));
    expect(summary).toHaveTextContent(`Do zapłaty${money('39.98')}`);
  });

  it('paid order goes to the order page with "Zamówienie opłacone" and empties the cart', async () => {
    cartWith(MUG);
    const { user, router } = await renderAsCustomer('/checkout');

    await placeOrder(user, '4111 1111 1111 1111');

    expect(await screen.findByText('Zamówienie opłacone')).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/orders\/[0-9a-f-]{36}$/);
    expect(loadState().carts[SEED_IDS.customer]).toEqual([]);
    await vi.waitFor(() => expect(screen.getByRole('link', { name: /^Koszyk/ })).toHaveTextContent('Koszyk0'));
    // The card number was sent without spaces and is not kept anywhere in the page.
    expect(document.body).not.toHaveTextContent('4111');
  });

  it('card ending with 0: payment failed message, the cart stays', async () => {
    cartWith(MUG);
    const { user, router } = await renderAsCustomer('/checkout');

    await placeOrder(user, '4111111111111110');

    const failed = loadState().orders.find((o) => o.status === 'PAYMENT_FAILED' && o.items[0].productId === products.regular);
    expect(failed).toBeDefined();
    const shortId = failed!.id.slice(-8).toUpperCase();
    expect(
      await screen.findByText(`Płatność odrzucona — zamówienie nr ${shortId} ma status Płatność nieudana. Możesz spróbować ponownie.`),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/checkout');
    expect(screen.getByLabelText('Numer karty')).toHaveValue('');
    expect(loadState().carts[SEED_IDS.customer]).toHaveLength(1);
  });

  it('INSUFFICIENT_STOCK: message and a link to the cart', async () => {
    cartWith({ productId: products.noStock, name: 'Młynek do kawy', unitPriceCents: 8999, quantity: 1 });
    const { user } = await renderAsCustomer('/checkout');

    await placeOrder(user, '4111111111111111');

    expect(await screen.findByText('Za mało sztuk w magazynie.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Przejdź do koszyka' })).toHaveAttribute('href', '/cart');
  });

  it('PRODUCT_UNAVAILABLE: message and a link to the cart', async () => {
    cartWith(MUG);
    server.use(
      http.post('*/api/v1/orders', () =>
        HttpResponse.json({ status: 409, error: 'PRODUCT_UNAVAILABLE', message: 'x', requestId: 'r' }, { status: 409 }),
      ),
    );
    const { user } = await renderAsCustomer('/checkout');

    await placeOrder(user, '4111111111111111');

    expect(await screen.findByText('Produkt z koszyka nie jest już dostępny. Usuń go z koszyka.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Przejdź do koszyka' })).toHaveAttribute('href', '/cart');
  });

  it('CART_EMPTY goes to the cart', async () => {
    cartWith(MUG);
    server.use(
      http.post('*/api/v1/orders', () => HttpResponse.json({ status: 409, error: 'CART_EMPTY', message: 'x', requestId: 'r' }, { status: 409 })),
    );
    const { user, router } = await renderAsCustomer('/checkout');

    await placeOrder(user, '4111111111111111');

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/cart'));
  });

  it('validates the card and the shipping method before sending', async () => {
    cartWith(MUG);
    const create = vi.fn();
    server.use(http.post('*/api/v1/orders', create));
    const { user } = await renderAsCustomer('/checkout');

    await user.type(await screen.findByLabelText('Numer karty'), '1234 5678');
    await user.click(screen.getByRole('button', { name: 'Zamawiam i płacę' }));

    expect(await screen.findByText('Numer karty musi mieć od 12 do 19 cyfr.')).toBeInTheDocument();
    expect(screen.getByText('Wybierz sposób dostawy.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('new address with "Zapisz w profilu" is saved and used for the order', async () => {
    cartWith(MUG);
    const { user } = await renderAsCustomer('/checkout');

    await user.click(await screen.findByLabelText('Nowy adres'));
    await user.type(screen.getByLabelText('Ulica i numer'), 'ul. Nowa 5');
    await user.type(screen.getByLabelText('Miasto'), 'Kraków');
    await user.type(screen.getByLabelText('Kod pocztowy'), '30-001');
    await user.click(screen.getByLabelText('Zapisz w profilu'));
    await placeOrder(user, '4111111111111111');

    expect(await screen.findByText('Zamówienie opłacone')).toBeInTheDocument();
    const state = loadState();
    expect(state.addresses.filter((a) => a.userId === SEED_IDS.customer).map((a) => a.street)).toContain('ul. Nowa 5');
    const order = state.orders.find((o) => o.shippingAddress.street === 'ul. Nowa 5');
    expect(order?.shippingAddress).toMatchObject({ city: 'Kraków', postalCode: '30-001', countryCode: 'PL', firstName: 'Jan' });
    expect(within(document.body).getByText(/Kraków/)).toBeInTheDocument();
  });

  it('the card number does not stay in the MutationCache after a rejected or a paid order (C5)', async () => {
    const queryClient = captureQueryClient();
    try {
      cartWith(MUG);
      const { user } = await renderAsCustomer('/checkout');

      await placeOrder(user, '4111111111111110');
      expect(await screen.findByText(/^Płatność odrzucona/)).toBeInTheDocument();
      // The page is still open with the result, the mutation with the card is gone.
      expect(cardNumbersInMutationCache(queryClient())).toEqual([]);

      await user.type(screen.getByLabelText('Numer karty'), '4111111111111111');
      await user.click(screen.getByRole('button', { name: 'Zamawiam i płacę' }));
      expect(await screen.findByText('Zamówienie opłacone')).toBeInTheDocument();
      expect(cardNumbersInMutationCache(queryClient())).toEqual([]);
    } finally {
      vi.doUnmock('@/api/query-client');
    }
  });

  it('the address list could not be reloaded after saving: "Wybierz adres dostawy." and the list is asked again (C21)', async () => {
    cartWith(MUG);
    let addressReads = 0;
    let orders = 0;
    server.use(
      http.get('*/api/v1/users/me/addresses', () => {
        addressReads += 1;
        // The first read (page load) goes to the mock User; later ones fail.
        if (addressReads > 1) return HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'x', requestId: 'r' }, { status: 503 });
      }),
      http.post('*/api/v1/orders', () => {
        orders += 1;
      }),
    );
    const { user } = await renderAsCustomer('/checkout');

    await user.click(await screen.findByLabelText('Nowy adres'));
    await user.type(screen.getByLabelText('Ulica i numer'), 'ul. Nowa 5');
    await user.type(screen.getByLabelText('Miasto'), 'Kraków');
    await user.type(screen.getByLabelText('Kod pocztowy'), '30-001');
    await user.click(screen.getByLabelText('Zapisz w profilu'));
    // Rejected payment; reloading the addresses after saving fails (503, retried once).
    await placeOrder(user, '4111111111111110');
    expect(await screen.findByText(/^Płatność odrzucona/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(orders).toBe(1);

    const reads = addressReads;
    await user.type(screen.getByLabelText('Numer karty'), '4111111111111111');
    await user.click(screen.getByRole('button', { name: 'Zamawiam i płacę' }));

    expect(await screen.findByText('Wybierz adres dostawy.')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Adres dostawy' })).toHaveAccessibleDescription('Wybierz adres dostawy.');
    await vi.waitFor(() => expect(addressReads).toBeGreaterThan(reads));
    expect(orders).toBe(1);
  });

  it('a missing shipping method moves the focus to its first option and describes the error (C25)', async () => {
    cartWith(MUG);
    const { user } = await renderAsCustomer('/checkout');

    await user.type(await screen.findByLabelText('Numer karty'), '4111111111111111');
    await screen.findByLabelText(/^Kurier/);
    await user.click(screen.getByRole('button', { name: 'Zamawiam i płacę' }));

    const group = screen.getByRole('radiogroup', { name: 'Sposób dostawy' });
    await vi.waitFor(() => expect(group).toHaveAccessibleDescription('Wybierz sposób dostawy.'));
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(within(group).getAllByRole('radio')[0]);
  });

  it('empty cart shows a message instead of the form', async () => {
    await renderAsCustomer('/checkout');
    expect(await screen.findByText('Koszyk jest pusty.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zamawiam i płacę' })).not.toBeInTheDocument();
  });
});
