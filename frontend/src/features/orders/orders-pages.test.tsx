import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { OrderStatus, ShipmentStatus } from '@/api/types';
import { loadState, mockConfig, updateState } from '@/mocks/db';
import { server, setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS, SEED_IDS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

const { orders } = SEED_IDS;

async function renderAsCustomer(path: string) {
  const view = await renderApp(`/login?returnTo=${encodeURIComponent(path)}`);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.customer.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.customer.password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  await vi.waitFor(() => expect(view.router.state.location.pathname).toBe(path));
  return { ...view, user };
}

/** Sets the status of the PAID seed order and of its shipment (null = no shipment yet). */
function paidOrderWith(status: OrderStatus, shipmentStatus: ShipmentStatus | null) {
  updateState((state) => {
    const order = state.orders.find((o) => o.id === orders.paid)!;
    order.status = status;
    if (shipmentStatus === null) {
      state.shipments = state.shipments.filter((s) => s.orderId !== orders.paid);
    } else {
      const shipment = state.shipments.find((s) => s.orderId === orders.paid)!;
      shipment.status = shipmentStatus;
      shipment.trackingNumber = shipmentStatus === 'PREPARING' ? null : 'PL1234567890';
    }
  });
}

/** Waits until the shipment section has loaded (with or without a shipment). */
async function shipmentLoaded() {
  const section = (await screen.findByRole('heading', { name: 'Przesyłka' })).closest('[data-slot="card"]') as HTMLElement;
  await vi.waitFor(() => expect(within(section).queryByRole('status')).not.toBeInTheDocument());
  return section;
}

describe('orders page', () => {
  it('lists own orders: number, date, status, total and the number of items', async () => {
    await renderAsCustomer('/orders');

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Liczba pozycji' })).toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => within(row).getAllByRole('cell')[2].textContent)).toEqual(['Opłacone', 'Wysłane', 'Dostarczone', 'Płatność nieudana']);
    // The delivered order has 2 different products (3 pieces): the column counts items, not pieces (Z10).
    expect(within(rows[2]).getAllByRole('cell')[4]).toHaveTextContent('2');
    expect(within(rows[0]).getByRole('link', { name: orders.paid.slice(-8).toUpperCase() })).toHaveAttribute('href', `/orders/${orders.paid}`);
  });
});

describe('order details', () => {
  it('shows items, sums, address and the shipment without a tracking number yet', async () => {
    await renderAsCustomer(`/orders/${orders.paid}`);

    expect(await screen.findByRole('heading', { name: `Zamówienie nr ${orders.paid.slice(-8).toUpperCase()}` })).toBeInTheDocument();
    expect(screen.getByText('Czysty kod')).toBeInTheDocument();
    expect(screen.getByText('Dostawa (Odbiór osobisty)')).toBeInTheDocument();
    expect(screen.getByText('ul. Testowa 1', { exact: false })).toBeInTheDocument();
    const shipment = await shipmentLoaded();
    expect(within(shipment).getByText('Numer śledzenia pojawi się po nadaniu paczki')).toBeInTheDocument();
    expect(within(shipment).getByRole('list', { name: 'Historia przesyłki' })).toHaveTextContent('W przygotowaniu');
  });

  it('PAID without a shipment yet: "W przygotowaniu — …"', async () => {
    paidOrderWith('PAID', null);
    await renderAsCustomer(`/orders/${orders.paid}`);

    const shipment = await shipmentLoaded();
    expect(within(shipment).getByText('W przygotowaniu — przesyłka pojawi się po przetworzeniu zamówienia')).toBeInTheDocument();
  });

  it.each<[string, OrderStatus, ShipmentStatus | null, boolean]>([
    ['NEW without a shipment', 'NEW', null, true],
    ['PAID without a shipment', 'PAID', null, true],
    ['PAID with PREPARING', 'PAID', 'PREPARING', true],
    ['PAID with SHIPPED', 'PAID', 'SHIPPED', false],
    ['CANCELLED', 'CANCELLED', 'CANCELLED', false],
    ['PAYMENT_FAILED', 'PAYMENT_FAILED', null, false],
  ])('"Anuluj zamówienie" for %s: %s', async (_name, status, shipmentStatus, visible) => {
    paidOrderWith(status, shipmentStatus);
    await renderAsCustomer(`/orders/${orders.paid}`);

    await shipmentLoaded();
    expect(screen.queryByRole('button', { name: 'Anuluj zamówienie' }) !== null).toBe(visible);
  });

  it('Shipping unavailable (503): the section shows the message, "Anuluj zamówienie" stays for PAID', async () => {
    server.use(
      http.get('*/api/v1/shipments', () =>
        HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'x', requestId: 'r-503' }, { status: 503 }),
      ),
    );
    await renderAsCustomer(`/orders/${orders.paid}`);

    // GET is retried once on 503 (decision 12, ~1 s) before the section shows the error.
    const title = await screen.findByText('Nie udało się wczytać przesyłki', {}, { timeout: 3000 });
    const shipment = title.closest('[data-slot="card"]') as HTMLElement;
    expect(within(shipment).getByRole('heading', { name: 'Przesyłka' })).toBeInTheDocument();
    expect(within(shipment).getByRole('button', { name: 'Spróbuj ponownie' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anuluj zamówienie' })).toBeInTheDocument();
  });

  it('cancels after the confirmation', async () => {
    const { user } = await renderAsCustomer(`/orders/${orders.paid}`);
    await shipmentLoaded();

    await user.click(screen.getByRole('button', { name: 'Anuluj zamówienie' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Tak, anuluj' }));

    await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Anuluj zamówienie' })).not.toBeInTheDocument());
    expect(screen.getAllByText('Anulowane').length).toBeGreaterThan(0);
    expect(await screen.findByText('Anulowana')).toBeInTheDocument();
    expect(loadState().orders.find((o) => o.id === orders.paid)?.status).toBe('CANCELLED');
  });

  it('cancelled order: the PREPARING shipment is polled until Shipping cancels it, then polling stops', async () => {
    // Only intervals are fake: TanStack polling is driven by the test, everything else runs normally.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Shipping handles order.cancelled a moment later (the mock plans the change, see mocks/handlers/orders.ts).
    mockConfig.shipmentDelayMs = 60_000;
    try {
      let shipmentReads = 0;
      server.use(
        http.get('*/api/v1/shipments', () => {
          shipmentReads += 1;
        }),
      );
      const { user } = await renderAsCustomer(`/orders/${orders.paid}`);
      const section = await shipmentLoaded();

      await user.click(screen.getByRole('button', { name: 'Anuluj zamówienie' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Tak, anuluj' }));
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Anuluj zamówienie' })).not.toBeInTheDocument());
      // The refresh right after cancelling still sees the shipment PREPARING.
      const readsAfterCancel = shipmentReads;
      expect(within(section).getAllByText('W przygotowaniu').length).toBeGreaterThan(0);

      // Still PREPARING after 10 s: asked again.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(shipmentReads).toBe(readsAfterCancel + 1));
      expect(within(section).queryByText('Anulowana')).not.toBeInTheDocument();

      // Shipping has processed order.cancelled: the next poll shows it.
      updateState((state) => {
        state.shipments.find((s) => s.orderId === orders.paid)!.cancelAt = new Date(0).toISOString();
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await within(section).findByText('Anulowana')).toBeInTheDocument();

      // CANCELLED is final for both: no more requests.
      const reads = shipmentReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(shipmentReads).toBe(reads);
    } finally {
      mockConfig.shipmentDelayMs = 0;
      vi.useRealTimers();
    }
  });

  it('cancels an order without a shipment yet: "Brak przesyłki." and no polling', async () => {
    paidOrderWith('PAID', null);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let shipmentReads = 0;
      server.use(
        http.get('*/api/v1/shipments', () => {
          shipmentReads += 1;
        }),
      );
      const { user } = await renderAsCustomer(`/orders/${orders.paid}`);
      const section = await shipmentLoaded();
      expect(within(section).getByText('W przygotowaniu — przesyłka pojawi się po przetworzeniu zamówienia')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Anuluj zamówienie' }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Tak, anuluj' }));

      expect(await within(section).findByText('Brak przesyłki.')).toBeInTheDocument();
      expect(screen.getAllByText('Anulowane').length).toBeGreaterThan(0);
      const reads = shipmentReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(shipmentReads).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polling stops after a final status and does not run in a hidden tab', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    try {
      let orderReads = 0;
      server.use(
        http.get('*/api/v1/orders/:orderId', () => {
          orderReads += 1;
        }),
      );
      await renderAsCustomer(`/orders/${orders.paid}`);
      await shipmentLoaded();

      // Hidden tab: no polling.
      visibility.mockReturnValue('hidden');
      const hiddenReads = orderReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(orderReads).toBe(hiddenReads);

      // Visible again: polling goes on and picks up the delivery.
      visibility.mockReturnValue('visible');
      paidOrderWith('DELIVERED', 'DELIVERED');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await screen.findByRole('heading', { name: /Zamówienie nr/ })).toBeInTheDocument();
      await vi.waitFor(() => expect(screen.getAllByText('Dostarczone').length).toBeGreaterThan(0));

      // DELIVERED is final: no more requests.
      const finalReads = orderReads;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(orderReads).toBe(finalReads);
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('409 ORDER_NOT_CANCELLABLE shows the message and reloads the order', async () => {
    const { user } = await renderAsCustomer(`/orders/${orders.paid}`);
    await shipmentLoaded();
    // Meanwhile the admin shipped the parcel.
    paidOrderWith('SHIPPED', 'SHIPPED');
    server.use(
      http.post('*/api/v1/orders/:orderId/cancel', () =>
        HttpResponse.json({ status: 409, error: 'ORDER_NOT_CANCELLABLE', message: 'x', requestId: 'r' }, { status: 409 }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Anuluj zamówienie' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Tak, anuluj' }));

    expect(await screen.findByText('Tego zamówienia nie można już anulować.')).toBeInTheDocument();
    expect(await screen.findByText('Wysłana')).toBeInTheDocument();
    expect(screen.getByText('PL1234567890')).toBeInTheDocument();
  });

  it('an order of somebody else → "Nie znaleziono."', async () => {
    await renderAsCustomer('/orders/d0000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByText('Nie znaleziono.')).toBeInTheDocument();
  });
});
