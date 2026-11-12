// Every API path of the frontend in one place (decision 11). Paths are relative to API_PREFIX,
// which only the client (src/api/client.ts) puts in front of them. Contract: docs/frontend-api.md.

/** Public API prefix: the Gateway strips it and forwards `/<resource>/...` to the service. */
export const API_PREFIX = '/api/v1';

/** Auth endpoints: the client never sends the access token there and never refreshes on their 401. */
export const AUTH_PATH_PREFIX = '/auth/';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiEndpoint {
  method: HttpMethod;
  /** Path with `{param}` placeholders, e.g. `/products/{productId}`. */
  path: string;
}

/** Endpoints used by the frontend: the same list as the table in docs/frontend-api.md and the MSW handlers (test K35). */
export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  { method: 'POST', path: '/auth/register' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/refresh' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'GET', path: '/users/me' },
  { method: 'PUT', path: '/users/me' },
  { method: 'GET', path: '/users/me/addresses' },
  { method: 'POST', path: '/users/me/addresses' },
  { method: 'DELETE', path: '/users/me/addresses/{addressId}' },
  { method: 'GET', path: '/cart' },
  { method: 'POST', path: '/cart/items' },
  { method: 'PATCH', path: '/cart/items/{productId}' },
  { method: 'DELETE', path: '/cart/items/{productId}' },
  { method: 'GET', path: '/products' },
  { method: 'GET', path: '/products/{productId}' },
  { method: 'GET', path: '/categories' },
  { method: 'POST', path: '/products' },
  { method: 'PUT', path: '/products/{productId}' },
  { method: 'DELETE', path: '/products/{productId}' },
  { method: 'GET', path: '/inventory/{productId}' },
  { method: 'PUT', path: '/inventory/{productId}' },
  { method: 'GET', path: '/reviews' },
  { method: 'POST', path: '/reviews' },
  { method: 'DELETE', path: '/reviews/{reviewId}' },
  { method: 'POST', path: '/orders' },
  { method: 'GET', path: '/orders' },
  { method: 'GET', path: '/orders/{orderId}' },
  { method: 'POST', path: '/orders/{orderId}/cancel' },
  { method: 'GET', path: '/shipping/methods' },
  { method: 'GET', path: '/shipments' },
  { method: 'PATCH', path: '/shipments/{shipmentId}/status' },
];

// Identifiers are UUIDs, but they come from the address bar or the API, so they are always encoded.
// encodeURIComponent keeps "." and "..", and the URL parser drops them (also "%2E%2E") as dot segments,
// so they are rejected (Z17 a).
const segment = (value: string): string => {
  if (value === '.' || value === '..') throw new Error(`Invalid path parameter: ${value}`);
  return encodeURIComponent(value);
};

export const paths = {
  auth: {
    register: '/auth/register',
    login: '/auth/login',
    refresh: '/auth/refresh',
    logout: '/auth/logout',
  },
  users: {
    me: '/users/me',
    addresses: '/users/me/addresses',
    address: (addressId: string) => `/users/me/addresses/${segment(addressId)}`,
  },
  cart: {
    root: '/cart',
    items: '/cart/items',
    item: (productId: string) => `/cart/items/${segment(productId)}`,
  },
  products: {
    list: '/products',
    detail: (productId: string) => `/products/${segment(productId)}`,
  },
  categories: '/categories',
  inventory: (productId: string) => `/inventory/${segment(productId)}`,
  reviews: {
    list: '/reviews',
    detail: (reviewId: string) => `/reviews/${segment(reviewId)}`,
  },
  orders: {
    list: '/orders',
    detail: (orderId: string) => `/orders/${segment(orderId)}`,
    cancel: (orderId: string) => `/orders/${segment(orderId)}/cancel`,
  },
  shipping: {
    methods: '/shipping/methods',
  },
  shipments: {
    list: '/shipments',
    status: (shipmentId: string) => `/shipments/${segment(shipmentId)}/status`,
  },
} as const;
