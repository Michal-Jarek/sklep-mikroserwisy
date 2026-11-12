// Reviews of a product: list (newest first, 10 per page), adding (logged in) and deleting (author or ADMIN).
// An error here stays in this section; the rest of the product page keeps working (decision 13).
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { useAddReview, useDeleteReview, useReviews } from '@/api/reviews';
import type { Review } from '@/api/types';
import { loginPath, useSession } from '@/auth/session';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { PageLoading } from '@/components/PageLoading';
import { Pagination } from '@/components/Pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { reviewStars } from '@/features/product/rating';
import { formatDate } from '@/lib/dates';

const SELECT_CLASS =
  'h-9 w-full max-w-48 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

const reviewSchema = z.object({
  rating: z
    .string()
    .regex(/^[1-5]$/, 'Wybierz ocenę od 1 do 5.')
    .transform(Number),
  comment: z
    .string()
    .max(2000, 'Komentarz może mieć najwyżej 2000 znaków.')
    .transform((value) => value.trim() || null),
});

function ReviewForm({ productId }: { productId: string }) {
  const add = useAddReview(productId);
  const form = useForm<z.input<typeof reviewSchema>, unknown, z.output<typeof reviewSchema>>({
    resolver: zodResolver(reviewSchema),
    defaultValues: { rating: '', comment: '' },
  });
  const { errors } = form.formState;

  function onSubmit(values: z.output<typeof reviewSchema>) {
    add.mutate(values, {
      onSuccess: () => {
        form.reset();
        toast.success('Dodano opinię.');
      },
    });
  }

  return (
    <form noValidate aria-label="Dodaj opinię" className="grid gap-4 rounded-xl border p-4" onSubmit={form.handleSubmit(onSubmit)}>
      <h3 className="font-medium">Twoja ocena</h3>
      {add.isError && <ErrorAlert error={add.error} context="review" />}
      <FormField id="review-rating" label="Ocena" error={errors.rating?.message}>
        <select id="review-rating" className={SELECT_CLASS} aria-invalid={!!errors.rating} aria-describedby="review-rating-message" {...form.register('rating')}>
          <option value="">Wybierz</option>
          {[5, 4, 3, 2, 1].map((value) => (
            <option key={value} value={String(value)}>
              {value}
            </option>
          ))}
        </select>
      </FormField>
      <FormField id="review-comment" label="Komentarz (opcjonalnie)" error={errors.comment?.message}>
        <Textarea id="review-comment" rows={4} aria-invalid={!!errors.comment} aria-describedby="review-comment-message" {...form.register('comment')} />
      </FormField>
      <Button type="submit" className="justify-self-start" disabled={add.isPending}>
        Dodaj opinię
      </Button>
    </form>
  );
}

function ReviewItem({ review, own, canDelete, deleting, onDelete }: { review: Review; own: boolean; canDelete: boolean; deleting: boolean; onDelete: () => void }) {
  const stars = reviewStars(review.rating);
  const date = formatDate(review.createdAt);
  return (
    <li className="grid gap-1 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {stars === null ? (
          <span aria-label="Ocena niedostępna">—</span>
        ) : (
          <span aria-label={`Ocena ${stars} z 5`} className="text-amber-500">
            {'★'.repeat(stars)}
            <span className="text-muted-foreground">{'☆'.repeat(5 - stars)}</span>
          </span>
        )}
        <span className="text-sm text-muted-foreground">{date}</span>
        {own && <Badge variant="secondary">Twoja opinia</Badge>}
        {canDelete && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            // The visible text plus which review: the buttons differ for a screen reader.
            aria-label={`Usuń opinię z ${date}, ocena ${stars ?? '—'} z 5`}
            disabled={deleting}
            onClick={onDelete}
          >
            Usuń opinię
          </Button>
        )}
      </div>
      {review.comment && <p className="whitespace-pre-line">{review.comment}</p>}
    </li>
  );
}

export function ReviewsSection({ productId }: { productId: string }) {
  const [page, setPage] = useState(1);
  const reviews = useReviews(productId, page);
  const remove = useDeleteReview(productId);
  const session = useSession();
  const location = useLocation();
  const isAdmin = session.roles.includes('ADMIN');

  return (
    <section aria-labelledby="reviews-heading" className="grid gap-4">
      <h2 id="reviews-heading" className="text-xl font-semibold">
        Opinie
      </h2>

      {session.status === 'authenticated' && <ReviewForm productId={productId} />}
      {session.status === 'anonymous' && (
        <p className="text-muted-foreground">
          <Link to={loginPath(location.pathname)} className="underline">
            Zaloguj się
          </Link>
          , aby dodać opinię.
        </p>
      )}

      {remove.isError && <ErrorAlert error={remove.error} />}
      {reviews.isPending && <PageLoading label="Ładowanie opinii" />}
      {reviews.isError && <ErrorAlert error={reviews.error} title="Nie udało się wczytać opinii" onRetry={() => void reviews.refetch()} />}
      {reviews.data && reviews.data.items.length === 0 && reviews.data.total === 0 && <p className="text-muted-foreground">Nikt jeszcze nie ocenił tego produktu.</p>}
      {/* A page past the end (e.g. after deleting the last reviews of the last page): a way back. */}
      {reviews.data && reviews.data.items.length === 0 && reviews.data.total > 0 && (
        <p className="text-muted-foreground">
          Ta strona jest pusta.{' '}
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => setPage(Math.ceil(reviews.data.total / reviews.data.size))}>
            Przejdź do ostatniej strony
          </Button>
        </p>
      )}
      {reviews.data && reviews.data.items.length > 0 && (
        <>
          <ul aria-label="Lista opinii" className="grid gap-3">
            {reviews.data.items.map((review) => {
              const own = review.userId === session.userId;
              return (
                <ReviewItem
                  key={review.id}
                  review={review}
                  own={own}
                  canDelete={own || isAdmin}
                  deleting={remove.isPending}
                  onDelete={() => remove.mutate(review.id, { onSuccess: () => toast.success('Usunięto opinię.') })}
                />
              );
            })}
          </ul>
          <Pagination page={reviews.data.page} size={reviews.data.size} total={reviews.data.total} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}
