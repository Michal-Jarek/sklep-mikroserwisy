import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { updateState } from '@/mocks/db';
import { setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS, SEED_IDS } from '@/mocks/seed';
import { formatMoney } from '@/lib/money';
import { renderApp } from '@/test/render-app';

setupMockServer();

const { products } = SEED_IDS;

/** Amount as the page shows it; toHaveTextContent turns the non-breaking space of pl-PL into a space. */
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

function fillCart() {
  updateState((state) => {
    state.carts[SEED_IDS.customer] = [
      { productId: products.regular, name: 'Kubek ceramiczny', unitPriceCents: 1999, quantity: 2 },
      { productId: products.noStock, name: 'Młynek do kawy', unitPriceCents: 8999, quantity: 1 },
      { productId: products.lowStock, name: 'Mikroserwisy w praktyce', unitPriceCents: 7900, quantity: 1 },
    ];
  });
}

async function changeQuantity(user: ReturnType<typeof userEvent.setup>, name: string, quantity: string) {
  const input = screen.getByLabelText(`Ilość: ${name}`);
  await user.clear(input);
  await user.type(input, quantity);
  await user.click(screen.getByRole('button', { name: `Zmień ilość: ${name}` }));
}

describe('cart page', () => {
  it('anonymous visitor goes to the login page', async () => {
    const { router } = await renderApp('/cart');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?returnTo=%2Fcart');
  });

  it('empty cart: "Przejdź do zamówienia" is disabled', async () => {
    await renderAsCustomer('/cart');

    expect(await screen.findByText('Koszyk jest pusty.', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Przejdź do zamówienia' })).toBeDisabled();
  });

  it('shows the items and the total from the API', async () => {
    fillCart();
    await renderAsCustomer('/cart');

    const list = await screen.findByRole('list', { name: 'Pozycje koszyka' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Suma:').parentElement).toHaveTextContent(money('208.97'));
    expect(screen.getByRole('link', { name: 'Przejdź do zamówienia' })).toHaveAttribute('href', '/checkout');
  });

  it('changes the quantity; without stock data shows "Dostępność sprawdzimy przy zamówieniu"', async () => {
    fillCart();
    const { user } = await renderAsCustomer('/cart');
    await screen.findByRole('list', { name: 'Pozycje koszyka' });

    await changeQuantity(user, 'Kubek ceramiczny', '3');
    await vi.waitFor(() => expect(screen.getByText('Suma:').parentElement).toHaveTextContent(money('228.96')));
    expect(screen.queryByText('Dostępność sprawdzimy przy zamówieniu')).not.toBeInTheDocument();

    await changeQuantity(user, 'Młynek do kawy', '2');
    expect(await screen.findByText('Dostępność sprawdzimy przy zamówieniu')).toBeInTheDocument();
  });

  it('too many pieces → "Za mało sztuk w magazynie."', async () => {
    fillCart();
    const { user } = await renderAsCustomer('/cart');
    await screen.findByRole('list', { name: 'Pozycje koszyka' });

    await changeQuantity(user, 'Mikroserwisy w praktyce', '3');

    expect(await screen.findByText('Za mało sztuk w magazynie.')).toBeInTheDocument();
  });

  it('quantity must be 1–999', async () => {
    fillCart();
    const { user } = await renderAsCustomer('/cart');
    await screen.findByRole('list', { name: 'Pozycje koszyka' });

    await changeQuantity(user, 'Kubek ceramiczny', '0');
    expect(await screen.findByText('Podaj liczbę od 1 do 999.')).toBeInTheDocument();
    await changeQuantity(user, 'Kubek ceramiczny', '1000');
    expect(await screen.findByText('Podaj liczbę od 1 do 999.')).toBeInTheDocument();
  });

  it('removes an item; the header count follows', async () => {
    fillCart();
    const { user } = await renderAsCustomer('/cart');
    await screen.findByRole('list', { name: 'Pozycje koszyka' });
    await vi.waitFor(() => expect(screen.getByRole('link', { name: /^Koszyk/ })).toHaveTextContent('Koszyk3'));

    await user.click(screen.getByRole('button', { name: 'Usuń: Młynek do kawy' }));

    await vi.waitFor(() => expect(screen.queryByText('Młynek do kawy')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /^Koszyk/ })).toHaveTextContent('Koszyk2');
  });
});
