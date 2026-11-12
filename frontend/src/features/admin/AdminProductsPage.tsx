// Admin: product list with search and pages (filters in the address), add, edit and delete.
import { PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useDeleteProduct } from '@/api/admin-products';
import { useCategories } from '@/api/categories';
import { useProducts } from '@/api/products';
import type { ProductSummary } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Pagination } from '@/components/Pagination';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { readAdminProductsQuery } from '@/features/admin/admin-params';

/** Search waits for a pause in typing (decision 10). */
const SEARCH_DELAY_MS = 300;

function SearchField({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(value.trim()), SEARCH_DELAY_MS);
  }

  return (
    <div className="grid max-w-md gap-1.5">
      <Label htmlFor="admin-products-q">Szukaj produktu</Label>
      <Input id="admin-products-q" type="search" value={text} maxLength={200} onChange={onInput} />
    </div>
  );
}

function DeleteProductButton({ product, disabled, onConfirm }: { product: ProductSummary; disabled: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} aria-label={`Usuń produkt ${product.name}`}>
          Usuń
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Usunąć produkt?</AlertDialogTitle>
          <AlertDialogDescription>„{product.name}” zniknie z katalogu. Tej operacji nie można cofnąć.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Anuluj</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Usuń produkt
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminProductsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = readAdminProductsQuery(searchParams);
  const products = useProducts(query);
  const categories = useCategories();
  const remove = useDeleteProduct();

  const categoryName = (categoryId: string) => categories.data?.find((c) => c.id === categoryId)?.name ?? '';

  function search(q: string) {
    // A new search starts from the first page.
    setSearchParams(q ? { q } : {});
  }

  function changePage(page: number) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (page > 1) next.set('page', String(page));
      else next.delete('page');
      return next;
    });
  }

  function onDelete(product: ProductSummary) {
    remove.mutate(product.id, { onSuccess: () => toast.success(`Usunięto produkt „${product.name}”.`) });
  }

  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Produkty</h1>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/shipments">Przesyłki</Link>
          </Button>
          <Button asChild>
            <Link to="/admin/products/new">
              <PlusIcon />
              Dodaj produkt
            </Link>
          </Button>
        </div>
      </div>

      <SearchField q={query.q ?? ''} onSearch={search} />

      {remove.isError && <ErrorAlert error={remove.error} />}
      {products.isPending && <PageLoading label="Ładowanie produktów" />}
      {products.isError && <ErrorAlert error={products.error} onRetry={() => void products.refetch()} />}
      {products.data && products.data.items.length === 0 && products.data.total === 0 && <p className="text-muted-foreground">Nie znaleziono produktów.</p>}
      {/* A page past the end (e.g. after deleting the last product of the last page): a way back. */}
      {products.data && products.data.items.length === 0 && products.data.total > 0 && (
        <p className="text-muted-foreground">
          Ta strona jest pusta.{' '}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => changePage(Math.ceil(products.data.total / products.data.size))}>
            Przejdź do ostatniej strony
          </Button>
        </p>
      )}
      {products.data && products.data.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nazwa</TableHead>
                <TableHead>Kategoria</TableHead>
                <TableHead className="text-right">Cena</TableHead>
                <TableHead className="text-right">Akcje</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.data.items.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell>{categoryName(product.categoryId)}</TableCell>
                  <TableCell className="text-right">
                    <Money amount={product.price} currency={product.currency} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link to={`/admin/products/${product.id}`} aria-label={`Edytuj produkt ${product.name}`}>
                          Edytuj
                        </Link>
                      </Button>
                      <DeleteProductButton product={product} disabled={remove.isPending} onConfirm={() => onDelete(product)} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination page={products.data.page} size={products.data.size} total={products.data.total} onPageChange={changePage} />
        </>
      )}
    </section>
  );
}
