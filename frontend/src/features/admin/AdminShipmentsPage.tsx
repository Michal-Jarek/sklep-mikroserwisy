// Admin: shipments with the status filter in the address and the "next status" button
// (PREPARING → SHIPPED → IN_TRANSIT → DELIVERED).
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ApiError } from '@/api/errors';
import { useChangeShipmentStatus, useShipments } from '@/api/shipments';
import type { Shipment } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { PageLoading } from '@/components/PageLoading';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { nextShipmentStatus, readAdminShipmentsQuery, SHIPMENT_STATUSES } from '@/features/admin/admin-params';
import { shortOrderId } from '@/features/orders/order-rules';
import { formatDateTime } from '@/lib/dates';
import { SHIPMENT_STATUS_LABELS, shippingMethodLabel } from '@/lib/labels';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

/** Button text: the action that moves the shipment to the next status. */
const NEXT_STATUS_ACTIONS: Record<string, string> = {
  SHIPPED: 'Oznacz jako wysłaną',
  IN_TRANSIT: 'Oznacz jako w drodze',
  DELIVERED: 'Oznacz jako dostarczoną',
};

function ShipmentRow({ shipment, pending, onNext }: { shipment: Shipment; pending: boolean; onNext: () => void }) {
  const next = nextShipmentStatus(shipment.status);
  // The same order number as on the customer pages (Z19b).
  const orderNumber = shortOrderId(shipment.orderId);
  return (
    <TableRow>
      <TableCell>
        <Link to={`/orders/${shipment.orderId}`} className="font-mono underline" title={shipment.orderId}>
          {orderNumber}
        </Link>
      </TableCell>
      <TableCell>{shippingMethodLabel(shipment.method)}</TableCell>
      <TableCell>
        <StatusBadge kind="shipment" status={shipment.status} />
      </TableCell>
      <TableCell>
        {shipment.trackingNumber ?? <span className="text-muted-foreground">Numer śledzenia pojawi się po nadaniu paczki</span>}
      </TableCell>
      <TableCell>{formatDateTime(shipment.updatedAt)}</TableCell>
      <TableCell className="text-right">
        {next && (
          <Button type="button" size="sm" variant="outline" disabled={pending} aria-label={`${NEXT_STATUS_ACTIONS[next]}: zamówienie ${orderNumber}`} onClick={onNext}>
            {NEXT_STATUS_ACTIONS[next]}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export function AdminShipmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = readAdminShipmentsQuery(searchParams);
  const shipments = useShipments(query);
  const change = useChangeShipmentStatus();

  function changeStatusFilter(status: string) {
    // A new filter starts from the first page.
    setSearchParams(status ? { status } : {});
  }

  function changePage(page: number) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (page > 1) next.set('page', String(page));
      else next.delete('page');
      return next;
    });
  }

  function moveForward(shipment: Shipment) {
    const status = nextShipmentStatus(shipment.status);
    if (!status) return;
    change.mutate(
      { shipmentId: shipment.id, status },
      { onSuccess: () => toast.success(`Zmieniono status przesyłki na „${SHIPMENT_STATUS_LABELS[status]}”.`) },
    );
  }

  // 409: the status changed in the meantime; the list is refreshed by the mutation.
  const conflict = change.error instanceof ApiError && change.error.status === 409;

  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Przesyłki</h1>
        <Button asChild variant="outline">
          <Link to="/admin/products">Produkty</Link>
        </Button>
      </div>

      <div className="grid max-w-xs gap-1.5">
        <Label htmlFor="admin-shipments-status">Status</Label>
        <select id="admin-shipments-status" className={SELECT_CLASS} value={query.status ?? ''} onChange={(event) => changeStatusFilter(event.target.value)}>
          <option value="">Wszystkie</option>
          {SHIPMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {SHIPMENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      {change.isError && <ErrorAlert error={change.error} title={conflict ? 'Lista została odświeżona.' : undefined} />}
      {shipments.isPending && <PageLoading label="Ładowanie przesyłek" />}
      {shipments.isError && <ErrorAlert error={shipments.error} onRetry={() => void shipments.refetch()} />}
      {shipments.data && shipments.data.items.length === 0 && <p className="text-muted-foreground">Brak przesyłek.</p>}
      {shipments.data && shipments.data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zamówienie</TableHead>
                <TableHead>Dostawa</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Numer śledzenia</TableHead>
                <TableHead>Zmiana</TableHead>
                <TableHead className="text-right">Akcja</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.data.items.map((shipment) => (
                <ShipmentRow key={shipment.id} shipment={shipment} pending={change.isPending} onNext={() => moveForward(shipment)} />
              ))}
            </TableBody>
          </Table>
          <Pagination page={shipments.data.page} size={shipments.data.size} total={shipments.data.total} onPageChange={changePage} />
        </>
      )}
    </section>
  );
}
