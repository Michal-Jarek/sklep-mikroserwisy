// Admin: one page for /admin/products/new (no productId) and /admin/products/:productId (edit with the
// stock panel; stock only for one product at a time, decision 10).
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeftIcon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { useCreateProduct, useUpdateProduct } from '@/api/admin-products';
import { useCategories } from '@/api/categories';
import { ApiError } from '@/api/errors';
import { useStock, useUpdateStock } from '@/api/inventory';
import { useProduct } from '@/api/products';
import type { Category, ProductDetail, StockLevel } from '@/api/types';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormField } from '@/components/FormField';
import { PageLoading } from '@/components/PageLoading';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  EMPTY_PRODUCT_FORM,
  productFormSchema,
  productFormValues,
  stockFormSchema,
  toProductRequest,
  type ProductFormInput,
  type ProductFormOutput,
} from '@/features/admin/product-form';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

function ProductForm({ product, categories }: { product?: ProductDetail; categories: Category[] }) {
  const navigate = useNavigate();
  const create = useCreateProduct();
  const update = useUpdateProduct(product?.id ?? '');
  const save = product ? update : create;
  const form = useForm<ProductFormInput, unknown, ProductFormOutput>({
    resolver: zodResolver(productFormSchema),
    defaultValues: product ? productFormValues(product) : EMPTY_PRODUCT_FORM,
  });
  const { errors } = form.formState;

  // After an error the form keeps what was typed (no reset), so the admin can correct and send again.
  function onSubmit(values: ProductFormOutput) {
    const body = toProductRequest(values);
    if (product) {
      update.mutate(body, { onSuccess: () => toast.success('Zapisano produkt.') });
    } else {
      create.mutate(body, {
        onSuccess: (created) => {
          toast.success('Dodano produkt.');
          navigate(`/admin/products/${created.id}`, { replace: true });
        },
      });
    }
  }

  return (
    <form noValidate className="grid gap-4" onSubmit={form.handleSubmit(onSubmit)}>
      {save.isError && <ErrorAlert error={save.error} />}
      <FormField id="product-name" label="Nazwa" error={errors.name?.message}>
        <Input id="product-name" maxLength={200} aria-invalid={!!errors.name} aria-describedby="product-name-message" {...form.register('name')} />
      </FormField>
      <FormField id="product-description" label="Opis" error={errors.description?.message}>
        <Textarea id="product-description" rows={5} aria-invalid={!!errors.description} aria-describedby="product-description-message" {...form.register('description')} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="product-price" label="Cena (zł)" error={errors.price?.message} hint="Np. 19,99">
          <Input id="product-price" inputMode="decimal" aria-invalid={!!errors.price} aria-describedby="product-price-message" {...form.register('price')} />
        </FormField>
        <FormField id="product-category" label="Kategoria" error={errors.categoryId?.message}>
          <select id="product-category" className={SELECT_CLASS} aria-invalid={!!errors.categoryId} aria-describedby="product-category-message" {...form.register('categoryId')}>
            <option value="">Wybierz kategorię</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField id="product-image-url" label="Adres zdjęcia" error={errors.imageUrl?.message} hint="https://… albo puste (bez zdjęcia)">
        <Input id="product-image-url" type="url" inputMode="url" aria-invalid={!!errors.imageUrl} aria-describedby="product-image-url-message" {...form.register('imageUrl')} />
      </FormField>
      <Button type="submit" className="justify-self-start" disabled={save.isPending}>
        {product ? 'Zapisz zmiany' : 'Dodaj produkt'}
      </Button>
    </form>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function StockForm({ productId, stock, onConflict }: { productId: string; stock: StockLevel | null; onConflict: () => void }) {
  const update = useUpdateStock(productId);
  const form = useForm<z.input<typeof stockFormSchema>, unknown, z.output<typeof stockFormSchema>>({
    resolver: zodResolver(stockFormSchema),
    defaultValues: { quantity: stock ? String(stock.quantity) : '' },
  });
  const { errors } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) =>
        update.mutate(values, {
          onSuccess: () => toast.success('Zapisano stan magazynowy.'),
          onError: (error) => {
            // 409 CONFLICT of PUT /inventory: the new quantity is lower than the reserved one. The stock is
            // reloaded, so the number in the message (from the stock prop) is the current one.
            if (error instanceof ApiError && error.status === 409) onConflict();
          },
        }),
      )}
    >
      {update.error instanceof ApiError && update.error.status === 409 ? (
        <Alert variant="destructive">
          <AlertDescription>Ilość nie może być mniejsza niż zarezerwowana ({stock?.reserved ?? 0} szt.).</AlertDescription>
        </Alert>
      ) : (
        update.isError && <ErrorAlert error={update.error} />
      )}
      <FormField id="stock-quantity" label="Ilość w magazynie" error={errors.quantity?.message} hint="Od 0 do 1 000 000; nie mniej niż zarezerwowane.">
        <Input id="stock-quantity" inputMode="numeric" className="max-w-40" aria-invalid={!!errors.quantity} aria-describedby="stock-quantity-message" {...form.register('quantity')} />
      </FormField>
      <Button type="submit" className="justify-self-start" disabled={update.isPending}>
        Zapisz stan
      </Button>
    </form>
  );
}

function StockPanel({ productId }: { productId: string }) {
  const stock = useStock(productId);

  return (
    <section aria-labelledby="stock-heading">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 id="stock-heading">Stan magazynowy</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {stock.isPending && <PageLoading label="Ładowanie stanu" />}
          {stock.isError && <ErrorAlert error={stock.error} onRetry={() => void stock.refetch()} />}
          {stock.data === null && <p className="text-muted-foreground">Brak stanu — ustaw ilość</p>}
          {stock.data && (
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">W magazynie</dt>
                <dd className="text-lg font-semibold">{stock.data.quantity}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Zarezerwowane</dt>
                <dd className="text-lg font-semibold">{stock.data.reserved}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Dostępne</dt>
                <dd className="text-lg font-semibold">{stock.data.available}</dd>
              </div>
            </dl>
          )}
          {/* The form starts from the loaded quantity; a new key after loading fills it. */}
          {stock.data !== undefined && <StockForm key={stock.data ? 'stock' : 'none'} productId={productId} stock={stock.data} onConflict={() => void stock.refetch()} />}
        </CardContent>
      </Card>
    </section>
  );
}

function EditProduct({ productId, categories }: { productId: string; categories: Category[] }) {
  const product = useProduct(productId);
  if (product.isPending) return <PageLoading label="Ładowanie produktu" />;
  if (product.isError) return <ErrorAlert error={product.error} onRetry={() => void product.refetch()} />;
  return (
    <>
      <Card>
        <CardContent>
          <ProductForm product={product.data} categories={categories} />
        </CardContent>
      </Card>
      <StockPanel productId={productId} />
    </>
  );
}

export function AdminProductFormPage() {
  const { productId } = useParams();
  const categories = useCategories();

  // The category list is needed before the form shows a product's category.
  let content;
  if (productId !== undefined && !UUID.test(productId)) {
    // Like the shop: an id that is not a UUID cannot be a product (the API would answer 400).
    content = (
      <Alert>
        <AlertDescription>Nie znaleziono.</AlertDescription>
      </Alert>
    );
  } else if (categories.isPending) {
    content = <PageLoading />;
  } else if (categories.isError) {
    content = <ErrorAlert error={categories.error} onRetry={() => void categories.refetch()} />;
  } else if (productId) {
    content = <EditProduct key={productId} productId={productId} categories={categories.data} />;
  } else {
    content = (
      <Card>
        <CardContent>
          <ProductForm categories={categories.data} />
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="grid max-w-3xl gap-6">
      <Button asChild variant="ghost" className="justify-self-start">
        <Link to="/admin/products">
          <ArrowLeftIcon />
          Wszystkie produkty
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold">{productId ? 'Edycja produktu' : 'Nowy produkt'}</h1>
      {content}
    </section>
  );
}
