import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { updateState } from '@/mocks/db';
import { server, setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS, SEED_IDS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

const { products } = SEED_IDS;

async function renderAsCustomer(path: string) {
  const view = await renderApp(`/login?returnTo=${encodeURIComponent(path)}`);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.customer.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.customer.password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  await vi.waitFor(() => expect(view.router.state.location.pathname).toBe(path));
  return { ...view, user };
}

describe('product page', () => {
  it('shows the rating, the availability and the newest 10 reviews', async () => {
    await renderApp(`/products/${products.regular}`);

    expect(await screen.findByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('4,1 / 5 (12 opinii)')).toBeInTheDocument();
    expect(screen.getByText('Dostępne: 50 szt.')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Lista opinii' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('Strona 1 z 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj do koszyka' })).toBeEnabled();
  });

  it('rating null → "Ocena chwilowo niedostępna"', async () => {
    await renderApp(`/products/${products.ratingUnavailable}`);
    expect(await screen.findByText('Ocena chwilowo niedostępna')).toBeInTheDocument();
  });

  it('rating count 0 → "Brak opinii"', async () => {
    await renderApp(`/products/${products.noReviews}`);
    expect(await screen.findByText('Brak opinii')).toBeInTheDocument();
    expect(await screen.findByText('Nikt jeszcze nie ocenił tego produktu.')).toBeInTheDocument();
  });

  it('availability null → "Dostępność sprawdzimy przy zamówieniu"', async () => {
    await renderApp(`/products/${products.inventoryUnavailable}`);
    expect(await screen.findByText('Dostępność sprawdzimy przy zamówieniu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj do koszyka' })).toBeEnabled();
  });

  it('no stock record = 0 pieces → "Brak w magazynie"', async () => {
    await renderApp(`/products/${products.noStock}`);
    expect(await screen.findByText('Brak w magazynie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj do koszyka' })).toBeDisabled();
  });

  it('inStock false → "Brak w magazynie" and the button is disabled', async () => {
    await renderApp(`/products/${products.outOfStock}`);
    expect(await screen.findByText('Brak w magazynie')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj do koszyka' })).toBeDisabled();
  });

  it('unknown product → "Nie znaleziono."', async () => {
    await renderApp('/products/a0000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Nie znaleziono.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Spróbuj ponownie' })).not.toBeInTheDocument();
  });

  it('Review unavailable: the message stays in the reviews section, the product is shown', async () => {
    server.use(
      http.get('*/api/v1/reviews', () => HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'x', requestId: 'rid-r' }, { status: 503 })),
    );
    await renderApp(`/products/${products.regular}`);

    expect(await screen.findByText('Nie udało się wczytać opinii', undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spróbuj ponownie' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj do koszyka' })).toBeEnabled();
  });

  it('a review rating outside 1–5 shows "—" instead of breaking the page (C20)', async () => {
    updateState((state) => {
      state.reviews.filter((r) => r.productId === products.regular).forEach((r, i) => {
        r.rating = i % 2 === 0 ? 6 : -1;
      });
    });
    await renderApp(`/products/${products.regular}`);

    const list = await screen.findByRole('list', { name: 'Lista opinii' });
    expect(within(list).getAllByLabelText('Ocena niedostępna')).toHaveLength(10);
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeInTheDocument();
  });

  it('a reviews page past the end: "Ta strona jest pusta." and a way to the last page (C27)', async () => {
    // Meanwhile two reviews were deleted: 10 left, page 2 is empty.
    server.use(
      http.get('*/api/v1/reviews', ({ request }) => {
        if (new URL(request.url).searchParams.get('page') === '2') return HttpResponse.json({ items: [], page: 2, size: 10, total: 10 });
      }),
    );
    await renderApp(`/products/${products.regular}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Następna' }));

    expect(await screen.findByText('Ta strona jest pusta.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Nikt jeszcze nie ocenił tego produktu.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Przejdź do ostatniej strony' }));
    expect(await screen.findByText('Strona 1 z 2')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Lista opinii' })).getAllByRole('listitem')).toHaveLength(10);
  });

  it('429 on the product shows "Spróbuj ponownie", which loads it again (C23)', async () => {
    let reads = 0;
    server.use(
      http.get('*/api/v1/products/:productId', () => {
        reads += 1;
        if (reads === 1) return HttpResponse.json({ status: 429, error: 'TOO_MANY_REQUESTS', message: 'x', requestId: 'rid-429' }, { status: 429, headers: { 'Retry-After': '5' } });
      }),
    );
    await renderApp(`/products/${products.regular}`);

    expect(await screen.findByText('Zbyt wiele prób. Spróbuj ponownie za 5 s.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Spróbuj ponownie' }));
    expect(await screen.findByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeInTheDocument();
  });

  it('anonymous "Dodaj do koszyka" goes to the login page and back to the product', async () => {
    const { router } = await renderApp(`/products/${products.regular}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Dodaj do koszyka' }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe(`?returnTo=${encodeURIComponent(`/products/${products.regular}`)}`);
  });
});

describe('product page, logged in', () => {
  it('adds to the cart; without stock data shows that availability is checked at the order', async () => {
    const { user } = await renderAsCustomer(`/products/${products.inventoryUnavailable}`);

    await user.click(await screen.findByRole('button', { name: 'Dodaj do koszyka' }));

    expect(await screen.findByText('Magazyn nie odpowiedział — dostępność sprawdzimy przy zamówieniu.')).toBeInTheDocument();
    const cartLink = screen.getByRole('link', { name: /^Koszyk/ });
    await vi.waitFor(() => expect(cartLink).toHaveTextContent('Koszyk1'));
  });

  it('own review is marked and can be deleted', async () => {
    const { user } = await renderAsCustomer(`/products/${products.regular}`);

    const list = await screen.findByRole('list', { name: 'Lista opinii' });
    const own = within(list).getByText('Twoja opinia').closest('li') as HTMLElement;
    // Only the own review has the delete button (no ADMIN role).
    expect(within(list).getAllByRole('button', { name: /^Usuń opinię/ })).toHaveLength(1);
    // The name says which review (C25): "Usuń opinię z <date>, ocena <n> z 5".
    expect(within(own).getByRole('button', { name: /^Usuń opinię z \d{1,2} \S+ \d{4}, ocena [1-5] z 5$/ })).toHaveTextContent('Usuń opinię');

    await user.click(within(own).getByRole('button', { name: /^Usuń opinię/ }));

    await vi.waitFor(() => expect(screen.queryByText('Twoja opinia')).not.toBeInTheDocument());
    expect(await screen.findByText('4,1 / 5 (11 opinii)')).toBeInTheDocument();
  });

  it('adds a review of a bought product; the second one gets "Ten produkt już oceniłeś."', async () => {
    const { user } = await renderAsCustomer(`/products/${products.purchased}`);

    await user.selectOptions(await screen.findByLabelText('Ocena'), '4');
    await user.type(screen.getByLabelText('Komentarz (opcjonalnie)'), 'Trzyma ciepło.');
    await user.click(screen.getByRole('button', { name: 'Dodaj opinię' }));

    expect(await screen.findByText('Trzyma ciepło.')).toBeInTheDocument();
    expect(screen.getByText('Twoja opinia')).toBeInTheDocument();
    expect(await screen.findByText('4,0 / 5 (1 opinia)')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Ocena'), '5');
    await user.click(screen.getByRole('button', { name: 'Dodaj opinię' }));
    expect(await screen.findByText('Ten produkt już oceniłeś.')).toBeInTheDocument();
  });

  it('a product not bought gets "Opinię może dodać tylko osoba, która kupiła ten produkt."', async () => {
    const { user } = await renderAsCustomer(`/products/${products.noReviews}`);

    await user.selectOptions(await screen.findByLabelText('Ocena'), '5');
    await user.click(screen.getByRole('button', { name: 'Dodaj opinię' }));

    expect(await screen.findByText('Opinię może dodać tylko osoba, która kupiła ten produkt.')).toBeInTheDocument();
  });

  it('validates the review before sending', async () => {
    const add = vi.fn();
    server.use(http.post('*/api/v1/reviews', add));
    const { user } = await renderAsCustomer(`/products/${products.purchased}`);

    await screen.findByLabelText('Ocena');
    await user.click(screen.getByLabelText('Komentarz (opcjonalnie)'));
    await user.paste('a'.repeat(2001));
    await user.click(screen.getByRole('button', { name: 'Dodaj opinię' }));

    expect(await screen.findByText('Wybierz ocenę od 1 do 5.')).toBeInTheDocument();
    expect(screen.getByText('Komentarz może mieć najwyżej 2000 znaków.')).toBeInTheDocument();
    expect(add).not.toHaveBeenCalled();
  });
});
