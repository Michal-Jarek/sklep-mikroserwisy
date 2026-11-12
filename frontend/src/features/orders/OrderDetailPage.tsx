// Order details with the shipment. The shipment appears after the order.created event, so its absence
// means "W przygotowaniu"; both are polled every 10 s while the tab is visible and the status may change (decision 15).
// After cancelling, the shipment is polled until Shipping cancels it too (order.cancelled is asynchronous).
import { useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError, isTemporaryError } from '@/api/errors';
import { useCancelOrder, useOrder } from '@/api/orders';
import { shipmentKeys, useShipments } from '@/api/shipments';
import type { OrderDetail, Page, Shipment } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { StatusBadge } from '@/components/StatusBadge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { canCancelOrder, shipmentRefreshInterval, shortOrderId } from '@/features/orders/order-rules';
import { formatDateTime } from '@/lib/dates';
import { SHIPMENT_STATUS_LABELS, shippingMethodLabel } from '@/lib/labels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ShipmentInfo({ order, shipments }: { order: OrderDetail; shipments: ReturnType<typeof useShipments> }) {
  if (shipments.isPending) return <PageLoading label="Ładowanie przesyłki" />;
  if (shipments.isError) return <ErrorAlert error={shipments.error} title="Nie udało się wczytać przesyłki" onRetry={() => void shipments.refetch()} />;

  const shipment = shipments.data.items[0];
  if (!shipment) {
    const waiting = order.status === 'NEW' || order.status === 'PAID';
    return <p>{waiting ? 'W przygotowaniu — przesyłka pojawi się po przetworzeniu zamówienia' : 'Brak przesyłki.'}</p>;
  }
  return (
    <div className="grid gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Status przesyłki</dt>
        <dd>
          <StatusBadge kind="shipment" status={shipment.status} />
        </dd>
        <dt className="text-muted-foreground">Numer śledzenia</dt>
        <dd>{shipment.trackingNumber ?? 'Numer śledzenia pojawi się po nadaniu paczki'}</dd>
      </dl>
      <ol aria-label="Historia przesyłki" className="grid gap-1 border-l pl-4 text-sm">
        {shipment.history.map((entry) => (
          <li key={`${entry.status}-${entry.at}`}>
            {SHIPMENT_STATUS_LABELS[entry.status] ?? entry.status} — {formatDateTime(entry.at)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CancelOrderButton({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="destructive" className="justify-self-start" disabled={pending}>
          Anuluj zamówienie
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Anulować zamówienie?</AlertDialogTitle>
          <AlertDialogDescription>Zamówienie zostanie anulowane, a rezerwacja produktów zwolniona. Tej operacji nie można cofnąć.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Nie</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Tak, anuluj</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function OrderView({ order, shipments, paid }: { order: OrderDetail; shipments: ReturnType<typeof useShipments>; paid: boolean }) {
  const shipment: Shipment | undefined = shipments.data?.items[0];
  // Hidden while the shipment loads; when Shipping does not answer, the order status alone decides.
  const cancellable = !shipments.isPending && canCancelOrder(order.status, shipments.isError ? 'unavailable' : shipment);
  // Kept here, not in the button: after 409 the order is reloaded and the button disappears, the message stays.
  const cancel = useCancelOrder(order.id);

  return (
    <div className="grid gap-6">
      {paid && order.status === 'PAID' && (
        <Alert>
          <AlertDescription>Zamówienie opłacone</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Zamówienie nr {shortOrderId(order.id)}</h1>
        <StatusBadge kind="order" status={order.status} />
      </div>
      <p className="text-sm text-muted-foreground">Złożone {formatDateTime(order.createdAt)}</p>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Produkty</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ul className="grid gap-1">
            {order.items.map((item) => (
              <li key={item.productId} className="flex justify-between gap-4">
                <span>
                  <Link to={`/products/${item.productId}`} className="hover:underline">
                    {item.name}
                  </Link>{' '}
                  × {item.quantity} (<Money amount={item.unitPrice} currency={order.currency} />)
                </span>
                <Money amount={item.subtotal} currency={order.currency} />
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-3">
            <dt>Wartość produktów</dt>
            <dd>
              <Money amount={order.itemsTotal} currency={order.currency} />
            </dd>
            <dt>Dostawa ({shippingMethodLabel(order.shippingMethod)})</dt>
            <dd>
              <Money amount={order.shippingCost} currency={order.currency} />
            </dd>
            <dt className="font-semibold">Razem</dt>
            <dd className="font-semibold">
              <Money amount={order.total} currency={order.currency} />
            </dd>
          </dl>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Adres dostawy</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <address className="not-italic">
              {order.shippingAddress.firstName} {order.shippingAddress.lastName}
              <br />
              {order.shippingAddress.street}
              <br />
              {order.shippingAddress.postalCode} {order.shippingAddress.city}, {order.shippingAddress.countryCode}
            </address>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Przesyłka</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ShipmentInfo order={order} shipments={shipments} />
          </CardContent>
        </Card>
      </div>

      {cancel.isError && <ErrorAlert error={cancel.error} />}
      {cancellable && (
        <CancelOrderButton pending={cancel.isPending} onConfirm={() => cancel.mutate(undefined, { onSuccess: () => toast.success('Zamówienie anulowane.') })} />
      )}
    </div>
  );
}

function OrderLoader({ orderId }: { orderId: string }) {
  const location = useLocation();
  const order = useOrder(orderId);
  // Loaded together with the order (no waterfall). The interval depends on the cached shipment: this component
  // re-renders when it changes, so the cache read here is the data useShipments returns below.
  const cachedShipment = useQueryClient().getQueryData<Page<Shipment>>(shipmentKeys.list({ orderId }))?.items[0];
  const shipments = useShipments({ orderId }, { refetchInterval: shipmentRefreshInterval(order.data?.status, cachedShipment) });
  const paid = (location.state as { paid?: boolean } | null)?.paid === true;

  if (order.isPending) return <PageLoading label="Ładowanie zamówienia" />;
  if (order.isError) {
    return (
      <section className="mx-auto grid max-w-lg gap-4 py-8">
        {/* 429: the message gives the wait time; the button is there at once, like after 503. */}
        <ErrorAlert
          error={order.error}
          onRetry={isTemporaryError(order.error) || (order.error instanceof ApiError && order.error.status === 429) ? () => void order.refetch() : undefined}
        />
        <Button asChild variant="outline" className="justify-self-start">
          <Link to="/orders">Wróć do zamówień</Link>
        </Button>
      </section>
    );
  }
  return <OrderView order={order.data} shipments={shipments} paid={paid} />;
}

export function OrderDetailPage() {
  const { orderId = '' } = useParams();
  // An id that is not a UUID cannot be an order (the API would answer 400).
  if (!UUID.test(orderId)) {
    return (
      <Alert className="mx-auto max-w-lg">
        <AlertDescription>Nie znaleziono.</AlertDescription>
      </Alert>
    );
  }
  return <OrderLoader orderId={orderId} />;
}
