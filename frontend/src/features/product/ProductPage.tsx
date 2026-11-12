// Product page: GET /products/{id} (rating and availability inside, both may be null) + reviews (decision 10).
import { ImageOffIcon } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useAddToCart } from '@/api/cart';
import { ApiError, isTemporaryError } from '@/api/errors';
import { useProduct } from '@/api/products';
import type { ProductAvailability, ProductDetail } from '@/api/types';
import { loginPath, useSession } from '@/auth/session';
import { ErrorAlert } from '@/components/ErrorAlert';
import { Money } from '@/components/Money';
import { PageLoading } from '@/components/PageLoading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ratingLabel } from '@/features/product/rating';
import { ReviewsSection } from '@/features/product/ReviewsSection';
import { imageSrc } from '@/lib/image';

function availabilityLabel(availability: ProductAvailability | null): string {
  if (availability === null) return 'Dostępność sprawdzimy przy zamówieniu';
  if (!availability.inStock) return 'Brak w magazynie';
  return `Dostępne: ${availability.available} szt.`;
}

function AddToCart({ product }: { product: ProductDetail }) {
  const session = useSession();
  const navigate = useNavigate();
  const add = useAddToCart();
  const outOfStock = product.availability?.inStock === false;

  function onClick() {
    // An anonymous visitor logs in and comes back to this product.
    if (session.status !== 'authenticated') {
      navigate(loginPath(`/products/${product.id}`));
      return;
    }
    add.mutate({ productId: product.id, quantity: 1 }, { onSuccess: () => toast.success('Dodano do koszyka.') });
  }

  return (
    <div className="grid gap-3">
      <Button type="button" size="lg" className="justify-self-start" disabled={outOfStock || session.status === 'loading' || add.isPending} onClick={onClick}>
        Dodaj do koszyka
      </Button>
      {add.isError && <ErrorAlert error={add.error} context="cart" />}
      {add.isSuccess && (
        <Alert>
          <AlertDescription>
            <p>
              Produkt jest w koszyku.{' '}
              <Link to="/cart" className="underline">
                Przejdź do koszyka
              </Link>
            </p>
            {!add.data.inventoryChecked && <p>Magazyn nie odpowiedział — dostępność sprawdzimy przy zamówieniu.</p>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function ProductDetails({ product }: { product: ProductDetail }) {
  const image = imageSrc(product.imageUrl);
  return (
    <div className="grid gap-8">
      <div className="grid gap-6 md:grid-cols-2">
        {image ? (
          <img src={image} alt={product.name} className="aspect-[4/3] w-full rounded-xl object-cover" />
        ) : (
          <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted text-muted-foreground">
            <ImageOffIcon className="size-10" />
            Brak zdjęcia
          </div>
        )}
        <div className="grid content-start gap-4">
          <div>
            <p className="text-sm text-muted-foreground">{product.category.name}</p>
            <h1 className="text-2xl font-semibold">{product.name}</h1>
          </div>
          <Money amount={product.price} currency={product.currency} className="text-2xl font-semibold" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Ocena</dt>
            <dd>{ratingLabel(product.rating)}</dd>
            <dt className="text-muted-foreground">Dostępność</dt>
            <dd>{availabilityLabel(product.availability)}</dd>
          </dl>
          <AddToCart product={product} />
          {product.description && <p className="whitespace-pre-line">{product.description}</p>}
        </div>
      </div>
      <ReviewsSection productId={product.id} />
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ProductLoader({ productId }: { productId: string }) {
  const product = useProduct(productId);

  if (product.isPending) return <PageLoading label="Ładowanie produktu" />;
  if (product.isError) {
    return (
      <section className="mx-auto grid max-w-lg gap-4 py-8">
        {/* 429: the message gives the wait time; the button is there at once, like after 503. */}
        <ErrorAlert
          error={product.error}
          onRetry={isTemporaryError(product.error) || (product.error instanceof ApiError && product.error.status === 429) ? () => void product.refetch() : undefined}
        />
        <Button asChild variant="outline" className="justify-self-start">
          <Link to="/">Wróć do katalogu</Link>
        </Button>
      </section>
    );
  }
  return <ProductDetails product={product.data} />;
}

export function ProductPage() {
  const { productId = '' } = useParams();
  // A link with an id that is not a UUID cannot point to a product (the API would answer 400).
  if (!UUID.test(productId)) {
    return (
      <Alert className="mx-auto max-w-lg">
        <AlertDescription>Nie znaleziono.</AlertDescription>
      </Alert>
    );
  }
  return <ProductLoader productId={productId} />;
}
