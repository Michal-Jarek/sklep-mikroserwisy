// Order history: own orders, newest first; the page number is in the address (?page=).
import { Link, useSearchParams } from 'react-router';
import { useOrders } from '@/api/orders';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { shortOrderId } from '@/features/orders/order-rules';
import { formatDateTime } from '@/lib/dates';

export function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = Number(searchParams.get('page'));
  const page = Number.isInteger(requested) && requested > 1 ? requested : 1;
  const orders = useOrders(page);

  let content;
  if (orders.isPending) {
    content = <PageLoading label="Ładowanie zamówień" />;
  } else if (orders.isError) {
    content = <ErrorAlert error={orders.error} onRetry={() => void orders.refetch()} />;
  } else if (orders.data.items.length === 0 && orders.data.total > 0) {
    // A page past the end (old link): a way back instead of "no orders yet".
    const lastPage = Math.ceil(orders.data.total / orders.data.size);
    content = (
      <p className="text-muted-foreground">
        Ta strona jest pusta.{' '}
        <Button type="button" variant="link" className="h-auto p-0" onClick={() => setSearchParams(lastPage > 1 ? { page: String(lastPage) } : {})}>
          Przejdź do ostatniej strony
        </Button>
      </p>
    );
  } else if (orders.data.items.length === 0) {
    content = (
      <p className="text-muted-foreground">
        Nie masz jeszcze zamówień.{' '}
        <Link to="/" className="underline">
          Przejdź do katalogu
        </Link>
      </p>
    );
  } else {
    content = (
      <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Numer</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Suma</TableHead>
              {/* itemCount = number of different products (Z10), not pieces. */}
              <TableHead className="text-right">Liczba pozycji</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.data.items.map((order) => (
              <TableRow key={order.id}>
                <TableCell>
                  <Link to={`/orders/${order.id}`} className="font-medium underline">
                    {shortOrderId(order.id)}
                  </Link>
                </TableCell>
                <TableCell>{formatDateTime(order.createdAt)}</TableCell>
                <TableCell>
                  <StatusBadge kind="order" status={order.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Money amount={order.total} currency={order.currency} />
                </TableCell>
                <TableCell className="text-right">{order.itemCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={orders.data.page}
          size={orders.data.size}
          total={orders.data.total}
          onPageChange={(next) => setSearchParams(next > 1 ? { page: String(next) } : {})}
        />
      </>
    );
  }

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-semibold">Zamówienia</h1>
      {content}
    </section>
  );
}
