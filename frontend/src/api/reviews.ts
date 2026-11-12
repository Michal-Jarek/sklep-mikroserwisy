// Product reviews (Review Service): list, add, delete on the product page.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import { productKeys } from '@/api/products';
import type { CreateReviewRequest, Page, Review } from '@/api/types';

export const REVIEWS_PAGE_SIZE = 10;

export const reviewKeys = {
  all: ['reviews'] as const,
  product: (productId: string) => [...reviewKeys.all, productId] as const,
  page: (productId: string, page: number) => [...reviewKeys.product(productId), page] as const,
};

/** GET /reviews?productId=: newest first, 10 per page. */
export function useReviews(productId: string, page: number) {
  return useQuery({
    queryKey: reviewKeys.page(productId, page),
    queryFn: ({ signal }) =>
      apiRequest<Page<Review>>(paths.reviews.list, { query: { productId, page, size: REVIEWS_PAGE_SIZE }, signal }),
    placeholderData: keepPreviousData,
  });
}

/** A new or deleted review changes the list and the rating of the product. */
function useInvalidateProductReviews(productId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewKeys.product(productId) }),
      queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) }),
    ]);
}

export function useAddReview(productId: string) {
  const invalidate = useInvalidateProductReviews(productId);
  return useMutation({
    mutationFn: (body: Omit<CreateReviewRequest, 'productId'>) =>
      apiRequest<Review>(paths.reviews.list, { method: 'POST', body: { productId, ...body } }),
    onSuccess: invalidate,
  });
}

export function useDeleteReview(productId: string) {
  const invalidate = useInvalidateProductReviews(productId);
  return useMutation({
    mutationFn: (reviewId: string) => apiRequest<void>(paths.reviews.detail(reviewId), { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
