import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { loadState, updateState } from '@/mocks/db';
import { server, setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS, SEED_IDS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

// "Czysty kod" (books, 69.90, stock 10 with 1 reserved, no image). Seed products with an image have
// `data:` placeholders, which PUT /products rejects (only https), so edits use this one.
const CLEAN_CODE = 'a0000000-0000-4000-8000-000000000009';

function errorBody(status: number, error: string) {
  return HttpResponse.json({ status, error, message: 'test', requestId: `rid-${status}` }, { status });
}

async function renderAsAdmin(path: string) {
  const view = await renderApp(`/login?returnTo=${encodeURIComponent(path)}`);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.admin.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.admin.password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  await vi.waitFor(() => expect(view.router.state.location.pathname + view.router.state.location.search).toBe(path));
  return { ...view, user };
}

describe('admin product form', () => {
  it('validates before sending', async () => {
    const create = vi.fn();
    server.use(http.post('*/api/v1/products', create));
    const { user } = await renderAsAdmin('/admin/products/new');

    await user.type(await screen.findByLabelText('Cena (zł)'), '19,999');
    await user.type(screen.getByLabelText('Adres zdjęcia'), 'http://img.example/a.png');
    await user.click(screen.getByRole('button', { name: 'Dodaj produkt' }));

    expect(await screen.findByText('Podaj nazwę.')).toBeInTheDocument();
    expect(screen.getByText('Podaj cenę, np. 19,99.')).toBeInTheDocument();
    expect(screen.getByText('Wybierz kategorię.')).toBeInTheDocument();
    expect(screen.getByText('Podaj adres zaczynający się od https:// albo zostaw puste.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('sends the price with a comma as "19.99" and an empty image address as null, then opens the edit page', async () => {
    let sent: unknown;
    server.use(
      http.post('*/api/v1/products', async ({ request }) => {
        sent = await request.clone().json();
        // No response: the request goes on to the mock Product.
      }),
    );
    const { user, router } = await renderAsAdmin('/admin/products/new');

    await user.type(await screen.findByLabelText('Nazwa'), 'Kubek testowy');
    await user.type(screen.getByLabelText('Opis'), 'Opis kubka');
    await user.type(screen.getByLabelText('Cena (zł)'), '19,99');
    await user.selectOptions(screen.getByLabelText('Kategoria'), 'Kuchnia');
    await user.click(screen.getByRole('button', { name: 'Dodaj produkt' }));

    await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/admin\/products\/[0-9a-f-]{36}$/));
    expect(sent).toEqual({ name: 'Kubek testowy', description: 'Opis kubka', price: '19.99', currency: 'PLN', categoryId: SEED_IDS.categories.kitchen, imageUrl: null });
    expect(await screen.findByRole('heading', { name: 'Edycja produktu' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Kubek testowy')).toBeInTheDocument();
    // A new product has no stock record yet.
    expect(await screen.findByText('Brak stanu — ustaw ilość')).toBeInTheDocument();
  });

  it('edit mode fills the fields and saves the changes', async () => {
    const { user } = await renderAsAdmin(`/admin/products/${CLEAN_CODE}`);

    const name = await screen.findByLabelText('Nazwa');
    expect(name).toHaveValue('Czysty kod');
    expect(screen.getByLabelText('Cena (zł)')).toHaveValue('69,90');
    expect(screen.getByLabelText('Kategoria')).toHaveValue(SEED_IDS.categories.books);
    expect(screen.getByLabelText('Adres zdjęcia')).toHaveValue('');

    await user.clear(screen.getByLabelText('Cena (zł)'));
    await user.type(screen.getByLabelText('Cena (zł)'), '24.5');
    await user.click(screen.getByRole('button', { name: 'Zapisz zmiany' }));

    expect(await screen.findByText('Zapisano produkt.')).toBeInTheDocument();
    expect(loadState().products.find((p) => p.id === CLEAN_CODE)?.priceCents).toBe(2450);
  });

  it('keeps the typed data after a failed save and shows the message with the request id', async () => {
    server.use(http.put('*/api/v1/products/:productId', () => errorBody(503, 'SERVICE_UNAVAILABLE')));
    const { user } = await renderAsAdmin(`/admin/products/${CLEAN_CODE}`);

    const name = await screen.findByLabelText('Nazwa');
    await user.clear(name);
    await user.type(name, 'Kubek zmieniony');
    await user.click(screen.getByRole('button', { name: 'Zapisz zmiany' }));

    expect(await screen.findByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeInTheDocument();
    expect(screen.getByText('Kod zgłoszenia: rid-503')).toBeInTheDocument();
    expect(screen.getByLabelText('Nazwa')).toHaveValue('Kubek zmieniony');
  });
});

describe('admin product form, address', () => {
  it('an id that is not a UUID → "Nie znaleziono." without calling the API (C22)', async () => {
    const read = vi.fn();
    server.use(http.get('*/api/v1/products/:productId', read));
    await renderAsAdmin('/admin/products/abc');

    expect(await screen.findByText('Nie znaleziono.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nazwa')).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('admin stock panel', () => {
  it('404 shows "Brak stanu — ustaw ilość" and saving creates the stock', async () => {
    const { user } = await renderAsAdmin(`/admin/products/${SEED_IDS.products.noStock}`);

    expect(await screen.findByText('Brak stanu — ustaw ilość')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ilość w magazynie'), '15');
    await user.click(screen.getByRole('button', { name: 'Zapisz stan' }));

    const panel = screen.getByRole('region', { name: 'Stan magazynowy' });
    expect(await within(panel).findByText('Dostępne')).toBeInTheDocument();
    expect(within(panel).getByText('W magazynie').nextSibling).toHaveTextContent('15');
    expect(screen.queryByText('Brak stanu — ustaw ilość')).not.toBeInTheDocument();
  });

  it('shows quantity, reserved and available; below reserved gives the reserved-quantity message and keeps the value (C24)', async () => {
    const { user } = await renderAsAdmin(`/admin/products/${CLEAN_CODE}`);

    const panel = await screen.findByRole('region', { name: 'Stan magazynowy' });
    expect(await within(panel).findByText('W magazynie')).toBeInTheDocument();
    expect(within(panel).getByText('W magazynie').nextSibling).toHaveTextContent('10');
    expect(within(panel).getByText('Zarezerwowane').nextSibling).toHaveTextContent('1');
    expect(within(panel).getByText('Dostępne').nextSibling).toHaveTextContent('9');

    const quantity = within(panel).getByLabelText('Ilość w magazynie');
    expect(quantity).toHaveValue('10');
    await user.clear(quantity);
    await user.type(quantity, '2');
    // Meanwhile a customer reserved two more pieces: the message shows the reloaded number.
    updateState((state) => {
      state.stock[CLEAN_CODE].reserved = 3;
    });
    await user.click(within(panel).getByRole('button', { name: 'Zapisz stan' }));

    expect(await within(panel).findByText('Ilość nie może być mniejsza niż zarezerwowana (3 szt.).')).toBeInTheDocument();
    expect(within(panel).getByText('Zarezerwowane').nextSibling).toHaveTextContent('3');
    expect(quantity).toHaveValue('2');
  });

  it('rejects a quantity above 1 000 000 before sending', async () => {
    const update = vi.fn();
    server.use(http.put('*/api/v1/inventory/:productId', update));
    const { user } = await renderAsAdmin(`/admin/products/${CLEAN_CODE}`);

    const quantity = await screen.findByLabelText('Ilość w magazynie');
    await user.clear(quantity);
    await user.type(quantity, '1000001');
    await user.click(screen.getByRole('button', { name: 'Zapisz stan' }));

    expect(await screen.findByText('Podaj liczbę całkowitą od 0 do 1 000 000.')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('admin product list', () => {
  it('search waits for a pause and is kept in the address', async () => {
    const { user, router } = await renderAsAdmin('/admin/products');

    expect(await screen.findByRole('cell', { name: 'Algorytmy' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Szukaj produktu'), 'kubek');

    await vi.waitFor(() => expect(router.state.location.search).toBe('?q=kubek'));
    expect(await screen.findByRole('cell', { name: 'Kubek ceramiczny' })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('cell', { name: 'Algorytmy' })).not.toBeInTheDocument());
  });

  it('deletes a product after confirmation', async () => {
    const { user } = await renderAsAdmin('/admin/products?q=kubek');

    await user.click(await screen.findByRole('button', { name: 'Usuń produkt Kubek ceramiczny' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/„Kubek ceramiczny” zniknie z katalogu/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Usuń produkt' }));

    expect(await screen.findByText('Nie znaleziono produktów.')).toBeInTheDocument();
    expect(loadState().products.some((p) => p.id === SEED_IDS.products.regular)).toBe(false);
  });

  it('a page past the end: "Ta strona jest pusta." and a way to the last page (C27)', async () => {
    const { user, router } = await renderAsAdmin('/admin/products?page=99');

    expect(await screen.findByText('Ta strona jest pusta.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Nie znaleziono produktów.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Przejdź do ostatniej strony' }));

    await vi.waitFor(() => expect(router.state.location.search).toMatch(/^(\?page=\d+)?$/));
    expect(router.state.location.search).not.toBe('?page=99');
    expect(await screen.findByRole('navigation', { name: 'Strony' })).toBeInTheDocument();
  });

  it('cancel in the confirmation keeps the product', async () => {
    const remove = vi.fn();
    server.use(http.delete('*/api/v1/products/:productId', remove));
    const { user } = await renderAsAdmin('/admin/products?q=kubek');

    await user.click(await screen.findByRole('button', { name: 'Usuń produkt Kubek ceramiczny' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Anuluj' }));

    expect(screen.getByRole('cell', { name: 'Kubek ceramiczny' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('admin shipments', () => {
  it('shows the next status button only for statuses that have one', async () => {
    await renderAsAdmin('/admin/shipments');

    const rows = await screen.findAllByRole('row');
    // Header + three seed shipments (newest first: preparing, shipped, delivered).
    expect(rows).toHaveLength(4);
    expect(screen.getByRole('button', { name: /^Oznacz jako wysłaną/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Oznacz jako w drodze/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Oznacz jako dostarczoną/ })).not.toBeInTheDocument();
    expect(screen.getByText('Numer śledzenia pojawi się po nadaniu paczki')).toBeInTheDocument();
    const hrefs = screen.getAllByRole('link', { name: /^[0-9A-F]{8}$/ }).map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([`/orders/${SEED_IDS.orders.paid}`, `/orders/${SEED_IDS.orders.shipped}`, `/orders/${SEED_IDS.orders.delivered}`]);
  });

  it('shows the same order number as the customer pages: last 8 characters in capitals (Z19b)', async () => {
    await renderAsAdmin('/admin/shipments');

    const number = SEED_IDS.orders.paid.slice(-8).toUpperCase();
    const link = await screen.findByRole('link', { name: number });
    expect(link).toHaveAttribute('href', `/orders/${SEED_IDS.orders.paid}`);
    expect(screen.getByRole('button', { name: `Oznacz jako wysłaną: zamówienie ${number}` })).toBeInTheDocument();
    // Seed order ids share the prefix d0000000: the old first-8 number was the same in every row.
    expect(new Set(screen.getAllByRole('link', { name: /^[0-9A-F]{8}$/ }).map((l) => l.textContent)).size).toBe(3);
  });

  it('moves a shipment to the next status', async () => {
    const { user } = await renderAsAdmin('/admin/shipments?status=PREPARING');

    await user.click(await screen.findByRole('button', { name: /^Oznacz jako wysłaną/ }));

    expect(await screen.findByText('Zmieniono status przesyłki na „Wysłana”.')).toBeInTheDocument();
    // The PREPARING filter no longer matches the shipment after the list is refreshed.
    expect(await screen.findByText('Brak przesyłek.')).toBeInTheDocument();
    expect(loadState().shipments.find((s) => s.id === SEED_IDS.shipments.preparing)?.trackingNumber).toMatch(/^PL\d{10}$/);
  });

  it('the status filter is kept in the address', async () => {
    const { user, router } = await renderAsAdmin('/admin/shipments');

    await user.selectOptions(await screen.findByLabelText('Status'), 'Dostarczona');

    await vi.waitFor(() => expect(router.state.location.search).toBe('?status=DELIVERED'));
    await vi.waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
  });

  it('409 INVALID_STATUS_TRANSITION shows the message and refreshes the list', async () => {
    let lists = 0;
    server.use(
      http.get('*/api/v1/shipments', () => {
        lists += 1;
      }),
      http.patch('*/api/v1/shipments/:shipmentId/status', () => errorBody(409, 'INVALID_STATUS_TRANSITION')),
    );
    const { user } = await renderAsAdmin('/admin/shipments');

    await user.click(await screen.findByRole('button', { name: /^Oznacz jako wysłaną/ }));

    expect(await screen.findByText('Nie można zmienić statusu przesyłki w ten sposób.')).toBeInTheDocument();
    await vi.waitFor(() => expect(lists).toBe(2));
  });
});
