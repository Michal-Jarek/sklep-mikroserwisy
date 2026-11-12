// Catalog: filters in the address, one GET /products per page (no calls per product, decision 10).
import { zodResolver } from '@hookform/resolvers/zod';
import { ImageOffIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useCategories } from '@/api/categories';
import { useProducts } from '@/api/products';
import type { ProductSort, ProductSummary } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Pagination } from '@/components/Pagination';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PRODUCT_SORTS, readCatalogQuery, withCatalogChanges, type CatalogParam } from '@/features/catalog/catalog-params';
import { imageSrc } from '@/lib/image';
import { parseAmountInput, toGrosze } from '@/lib/money';

/** Search waits for a pause in typing (decision 10, Gateway limit 300 requests/min/IP). */
const SEARCH_DELAY_MS = 300;

const SORT_LABELS: Record<ProductSort, string> = {
  NAME: 'Nazwa A–Z',
  PRICE_ASC: 'Cena rosnąco',
  PRICE_DESC: 'Cena malejąco',
  NEWEST: 'Najnowsze',
};

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

type ChangeFilters = (changes: Partial<Record<CatalogParam, string | undefined>>) => void;

function SearchField({ q, onChange }: { q: string; onChange: ChangeFilters }) {
  const [text, setText] = useState(q);
  const [shownQ, setShownQ] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The header search changed `q`: show it, unless it is what this field just sent.
  if (q !== shownQ) {
    setShownQ(q);
    if (q !== text.trim()) setText(q);
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange({ q: value.trim() }), SEARCH_DELAY_MS);
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor="catalog-q">Szukaj w nazwie i opisie</Label>
      <Input id="catalog-q" type="search" value={text} maxLength={200} onChange={onInput} />
    </div>
  );
}

const priceField = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === '') return undefined;
    const amount = parseAmountInput(value);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Podaj kwotę, np. 19,99.' });
      return z.NEVER;
    }
    return amount;
  });

const priceSchema = z
  .object({ minPrice: priceField, maxPrice: priceField })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || toGrosze(v.minPrice) <= toGrosze(v.maxPrice), {
    message: 'Cena „do” nie może być mniejsza niż „od”.',
    path: ['maxPrice'],
  });

function PriceFilter({ minPrice, maxPrice, onChange }: { minPrice?: string; maxPrice?: string; onChange: ChangeFilters }) {
  const form = useForm<z.input<typeof priceSchema>, unknown, z.output<typeof priceSchema>>({
    resolver: zodResolver(priceSchema),
    defaultValues: { minPrice: minPrice ?? '', maxPrice: maxPrice ?? '' },
  });
  const { errors } = form.formState;

  return (
    <form noValidate className="grid grid-cols-[1fr_1fr_auto] items-start gap-2" onSubmit={form.handleSubmit((values) => onChange(values))}>
      <FormField id="catalog-min-price" label="Cena od (zł)" error={errors.minPrice?.message}>
        <Input id="catalog-min-price" inputMode="decimal" aria-invalid={!!errors.minPrice} aria-describedby="catalog-min-price-message" {...form.register('minPrice')} />
      </FormField>
      <FormField id="catalog-max-price" label="Cena do (zł)" error={errors.maxPrice?.message}>
        <Input id="catalog-max-price" inputMode="decimal" aria-invalid={!!errors.maxPrice} aria-describedby="catalog-max-price-message" {...form.register('maxPrice')} />
      </FormField>
      <Button type="submit" variant="outline" className="mt-[1.375rem]">
        Filtruj
      </Button>
    </form>
  );
}

function ProductCard({ product }: { product: ProductSummary }) {
  const image = imageSrc(product.imageUrl);
  return (
    <li>
      <Link to={`/products/${product.id}`} className="block h-full rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        <Card className="h-full overflow-hidden pt-0 transition-shadow hover:shadow-md">
          {image ? (
            <img src={image} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover" />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-muted text-sm text-muted-foreground">
              <ImageOffIcon className="size-8" />
              Brak zdjęcia
            </div>
          )}
          <CardContent className="grid gap-1">
            <h2 className="font-medium">{product.name}</h2>
            <Money amount={product.price} currency={product.currency} className="font-semibold" />
          </CardContent>
        </Card>
      </Link>
    </li>
  );
}

export function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = readCatalogQuery(searchParams);
  const products = useProducts(query);
  const categories = useCategories();

  const change: ChangeFilters = (changes) => setSearchParams((current) => withCatalogChanges(current, changes));

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-semibold">Katalog</h1>

      <div aria-label="Filtry" role="group" className="grid gap-4 rounded-xl border p-4 md:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
        <SearchField q={query.q ?? ''} onChange={change} />
        <div className="grid gap-1.5">
          <Label htmlFor="catalog-category">Kategoria</Label>
          <select id="catalog-category" className={SELECT_CLASS} value={query.categoryId ?? ''} onChange={(event) => change({ categoryId: event.target.value })}>
            <option value="">Wszystkie kategorie</option>
            {categories.data?.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="catalog-sort">Sortowanie</Label>
          <select id="catalog-sort" className={SELECT_CLASS} value={query.sort ?? 'NAME'} onChange={(event) => change({ sort: event.target.value === 'NAME' ? '' : event.target.value })}>
            {PRODUCT_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2 lg:col-span-2">
          {/* A new key resets the form when the prices in the address change (e.g. "Wyczyść filtry"). */}
          <PriceFilter key={`${query.minPrice}-${query.maxPrice}`} minPrice={query.minPrice} maxPrice={query.maxPrice} onChange={change} />
        </div>
        <div className="flex items-end">
          <Button asChild variant="ghost">
            <Link to="/">Wyczyść filtry</Link>
          </Button>
        </div>
      </div>

      {products.isPending && <PageLoading label="Ładowanie produktów" />}
      {products.isError && <ErrorAlert error={products.error} onRetry={() => void products.refetch()} />}
      {products.data && products.data.items.length === 0 && products.data.total === 0 && <p className="text-muted-foreground">Nie znaleziono produktów.</p>}
      {/* A page past the end (old link, products removed meanwhile): a way back instead of "nothing found". */}
      {products.data && products.data.items.length === 0 && products.data.total > 0 && (
        <p className="text-muted-foreground">
          Ta strona jest pusta.{' '}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => change({ page: String(Math.ceil(products.data.total / products.data.size)) })}>
            Przejdź do ostatniej strony
          </Button>
        </p>
      )}
      {products.data && products.data.items.length > 0 && (
        <>
          <ul aria-label="Produkty" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {products.data.items.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </ul>
          <Pagination page={products.data.page} size={products.data.size} total={products.data.total} onPageChange={(page) => change({ page: String(page) })} />
        </>
      )}
    </section>
  );
}
