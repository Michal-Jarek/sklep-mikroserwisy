// State of the mock services. In the browser it lives in localStorage (survives reloads and is shared
// between tabs); in Node (Vitest) it lives in memory. Every handler loads the state, changes it and saves it.
import type {
  Address,
  Category,
  OrderDetail,
  Review,
  Shipment,
  ShippingMethod,
  UserProfile,
  UserRole,
} from '../api/types';
import { createSeed } from './seed';

export const STORAGE_KEY = 'sklep-mocks-v1';

export interface MockAccount {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: UserRole[];
}

export interface MockProduct {
  id: string;
  name: string;
  description: string;
  /** Price in grosze (integer). */
  priceCents: number;
  categoryId: string;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Mock only: the product page behaves as if Review were unavailable (rating: null). */
  ratingUnavailable?: boolean;
  /** Mock only: Product and Cart behave as if Inventory were unavailable (availability: null, inventoryChecked: false). */
  inventoryUnavailable?: boolean;
}

export interface MockStock {
  quantity: number;
  reserved: number;
}

export interface MockCartItem {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface MockAddress extends Address {
  userId: string;
}

export interface MockShipment extends Shipment {
  /** Mock only: the shipment is hidden until this time (it is created after the order.created event). */
  visibleAt: string;
  /** Mock only: the shipment becomes CANCELLED at this time (Shipping handles order.cancelled asynchronously). */
  cancelAt?: string;
}

export interface MockFailure {
  status: number;
  error: string;
  retryAfter?: number;
  /** Only requests with this method fail and count (failNext option `method`). */
  method?: string;
  remaining: number;
}

export interface MockState {
  accounts: MockAccount[];
  profiles: UserProfile[];
  addresses: MockAddress[];
  carts: Record<string, MockCartItem[]>;
  categories: Category[];
  products: MockProduct[];
  stock: Record<string, MockStock>;
  reviews: Review[];
  shippingMethods: ShippingMethod[];
  orders: OrderDetail[];
  shipments: MockShipment[];
  /** Refresh "cookie" of the mock Auth: the account that is logged in, or null. */
  session: { userId: string; rotation: number } | null;
  /** Errors planned by window.__mocks.failNext, per first path segment. */
  failures: Record<string, MockFailure>;
}

export interface MockConfig {
  /** Response delay range in ms (browser 100–300, tests 0). */
  delayMs: [number, number];
  /**
   * How long Shipping takes to react to an order event (browser 3000, tests 0): a new shipment stays hidden
   * after a paid order, and a cancelled order's shipment stays PREPARING.
   */
  shipmentDelayMs: number;
}

type StorageKind = 'memory' | 'local';

let storageKind: StorageKind = 'memory';
let memoryState: MockState | null = null;

export const mockConfig: MockConfig = { delayMs: [0, 0], shipmentDelayMs: 0 };

export function enableLocalStorage(): void {
  storageKind = 'local';
}

export function loadState(): MockState {
  if (storageKind === 'local') {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      return JSON.parse(raw) as MockState;
    }
    const seed = createSeed();
    saveState(seed);
    return seed;
  }
  if (memoryState === null) {
    memoryState = createSeed();
  }
  // A copy, like in localStorage: a handler that fails half-way does not leave half of its changes.
  return structuredClone(memoryState);
}

export function saveState(state: MockState): void {
  if (storageKind === 'local') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } else {
    memoryState = structuredClone(state);
  }
}

/** Back to the seed data, without a session and without planned errors. */
export function resetState(): void {
  saveState(createSeed());
}

/** Loads the state, lets `change` modify it and saves it. */
export function updateState<T>(change: (state: MockState) => T): T {
  const state = loadState();
  const result = change(state);
  saveState(state);
  return result;
}
