import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server, setupMockServer } from '@/mocks/node';
import { SEED_IDS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

/** Paths of API requests sent during the test (to check: one GET /products per page, no calls per product). */
const requests: string[] = [];
const recordRequest = ({ request }: { request: Request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
};
server.events.on('request:start', recordRequest);
afterEach(() => {
  requests.length = 0;
});

function productNames(): string[] {
  return within(screen.getByRole('list', { name: 'Produkty' }))
    .getAllByRole('heading')
    .map((heading) => heading.textContent ?? '');
}

describe('catalog page', () => {
  it('shows 12 products per page with one GET /products and no calls per product', async () => {
    await renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Algorytmy' })).toBeInTheDocument();
    expect(productNames()).toHaveLength(12);
    expect(productNames()[0]).toBe('Algorytmy');
    expect(screen.getByText('Strona 1 z 2')).toBeInTheDocument();
    expect(requests.filter((r) => r.startsWith('GET /api/v1/products'))).toEqual(['GET /api/v1/products']);
  });

  it('reads the filters from the address', async () => {
    await renderApp(`/?categoryId=${SEED_IDS.categories.electronics}&sort=PRICE_DESC`);

    expect(await screen.findByRole('heading', { name: 'Klawiatura mechaniczna' })).toBeInTheDocument();
    expect(productNames()).toEqual(['Klawiatura mechaniczna', 'Słuchawki bezprzewodowe', 'Powerbank 10000 mAh', 'Mysz komputerowa', 'Ładowarka USB-C', 'Kabel HDMI 2 m']);
    expect(screen.getByLabelText('Kategoria')).toHaveValue(SEED_IDS.categories.electronics);
    expect(screen.getByLabelText('Sortowanie')).toHaveValue('PRICE_DESC');
  });

  it('search waits for a pause in typing and writes q to the address', async () => {
    const { router } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Algorytmy' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Szukaj w nazwie i opisie'), 'kubek');

    await vi.waitFor(() => expect(router.state.location.search).toBe('?q=kubek'));
    await vi.waitFor(() => expect(productNames()).toEqual(['Kubek ceramiczny']));
    // One request after the pause, not one per letter.
    expect(requests.filter((r) => r === 'GET /api/v1/products')).toHaveLength(2);
  });

  it('category, sort and page are kept in the address; a filter change goes back to page 1', async () => {
    const { router } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Algorytmy' });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Następna' }));
    await vi.waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    expect(await screen.findByText('Strona 2 z 2')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Sortowanie'), 'PRICE_ASC');
    await vi.waitFor(() => expect(router.state.location.search).toBe('?sort=PRICE_ASC'));
    await vi.waitFor(() => expect(productNames()[0]).toBe('Nasiona ziół'));

    await user.selectOptions(screen.getByLabelText('Kategoria'), 'Ogród');
    await vi.waitFor(() => expect(router.state.location.search).toBe(`?sort=PRICE_ASC&categoryId=${SEED_IDS.categories.garden}`));
    await vi.waitFor(() => expect(productNames()).toHaveLength(6));
  });

  it('"back" restores the filters of the previous address: list and controls (C29)', async () => {
    const { router } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Algorytmy' });
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Kategoria'), 'Elektronika');
    await vi.waitFor(() => expect(router.state.location.search).toBe(`?categoryId=${SEED_IDS.categories.electronics}`));
    await user.selectOptions(screen.getByLabelText('Sortowanie'), 'PRICE_DESC');
    await vi.waitFor(() => expect(productNames()[0]).toBe('Klawiatura mechaniczna'));
    // Into a product and back twice: the product page, then the address before the sort change.
    await user.click(screen.getByRole('link', { name: /Klawiatura mechaniczna/ }));
    await screen.findByRole('heading', { name: 'Klawiatura mechaniczna', level: 1 });

    await router.navigate(-1);
    await vi.waitFor(() => expect(screen.getByLabelText('Sortowanie')).toHaveValue('PRICE_DESC'));
    expect(screen.getByLabelText('Kategoria')).toHaveValue(SEED_IDS.categories.electronics);
    await vi.waitFor(() => expect(productNames()[0]).toBe('Klawiatura mechaniczna'));

    await router.navigate(-1);
    await vi.waitFor(() => expect(screen.getByLabelText('Sortowanie')).toHaveValue('NAME'));
    expect(screen.getByLabelText('Kategoria')).toHaveValue(SEED_IDS.categories.electronics);
    await vi.waitFor(() => expect(productNames()).toHaveLength(6));
    expect(productNames()[0]).not.toBe('Klawiatura mechaniczna');
  });

  it('a page past the end: "Ta strona jest pusta." and a way to the last page (C27)', async () => {
    const { router } = await renderApp('/?page=99');

    expect(await screen.findByText('Ta strona jest pusta.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Nie znaleziono produktów.')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Przejdź do ostatniej strony' }));

    await vi.waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    expect(await screen.findByText('Strona 2 z 2')).toBeInTheDocument();
  });

  it('price filter accepts a comma and checks the range', async () => {
    const { router } = await renderApp('/');
    await screen.findByRole('heading', { name: 'Algorytmy' });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Cena od (zł)'), '100');
    await user.type(screen.getByLabelText('Cena do (zł)'), '50');
    await user.click(screen.getByRole('button', { name: 'Filtruj' }));
    expect(await screen.findByText('Cena „do” nie może być mniejsza niż „od”.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Cena do (zł)'));
    await user.type(screen.getByLabelText('Cena do (zł)'), '150,5');
    await user.click(screen.getByRole('button', { name: 'Filtruj' }));
    await vi.waitFor(() => expect(router.state.location.search).toBe('?minPrice=100.00&maxPrice=150.50'));
    await vi.waitFor(() => expect(productNames()).toEqual(['Algorytmy', 'Czajnik elektryczny', 'Leżak składany']));
  });

  it('shows an empty result', async () => {
    await renderApp('/?q=nie-ma-takiego');
    expect(await screen.findByText('Nie znaleziono produktów.')).toBeInTheDocument();
  });

  it('Product Service unavailable (503 twice, after one retry) shows the message with "Spróbuj ponownie"', async () => {
    let failures = 2;
    server.use(
      http.get('*/api/v1/products', () => {
        if (failures-- > 0) return HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'x', requestId: 'rid-503' }, { status: 503 });
        return undefined;
      }),
    );
    await renderApp('/');

    // The client retries a GET once after about 1 s (decision 12).
    expect(await screen.findByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText('Kod zgłoszenia: rid-503')).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(await screen.findByRole('heading', { name: 'Algorytmy' })).toBeInTheDocument();
  });
});
