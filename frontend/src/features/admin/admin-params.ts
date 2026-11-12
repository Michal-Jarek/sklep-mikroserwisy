// Filters of the admin lists live in the address (reload and links keep them). Values from the
// address are checked before they reach the API, which would answer 400.
import type { ProductListQuery, ShipmentListQuery, ShipmentStatus } from '@/api/types';

export const ADMIN_PAGE_SIZE = 20;

export const SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['PREPARING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];

const MAX_QUERY_LENGTH = 200;

function readPage(params: URLSearchParams): number {
  const page = Number(params.get('page'));
  return Number.isInteger(page) && page > 1 ? page : 1;
}

/** GET /products query of /admin/products (`q`, `page`). */
export function readAdminProductsQuery(params: URLSearchParams): ProductListQuery {
  const q = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  return { q: q || undefined, page: readPage(params), size: ADMIN_PAGE_SIZE };
}

/** GET /shipments query of /admin/shipments (`status`, `page`). */
export function readAdminShipmentsQuery(params: URLSearchParams): ShipmentListQuery {
  const status = params.get('status');
  return { status: SHIPMENT_STATUSES.find((s) => s === status), page: readPage(params), size: ADMIN_PAGE_SIZE };
}

const NEXT_STATUS: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
  PREPARING: 'SHIPPED',
  SHIPPED: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
};

/** The only allowed change is one step forward; DELIVERED and CANCELLED have none. */
export function nextShipmentStatus(status: ShipmentStatus): ShipmentStatus | null {
  return NEXT_STATUS[status] ?? null;
}
