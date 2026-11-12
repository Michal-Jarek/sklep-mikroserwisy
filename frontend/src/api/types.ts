// Request and response bodies of the services behind the API Gateway.
// Source of truth: docs/frontend-api.md (contract v1). Paths: src/api/paths.ts.

/** Amount as text with two decimals, e.g. "19.99" (decision D3). Never a JSON number. */
export type Money = string;
export type Currency = 'PLN';
/** UUID as lowercase text (decision D1). */
export type Uuid = string;
/** Date and time in ISO 8601, UTC, e.g. "2026-11-09T08:30:12.457Z". */
export type IsoDateTime = string;

/** Error body of every service and of the Gateway (decision D7). */
export interface ErrorBody {
  status: number;
  error: string;
  message: string;
  requestId: string;
}

/** One page of a list: page counted from 1, size 1–100. */
export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

export interface PageQuery {
  page?: number;
  size?: number;
}

// ---------- Auth ----------

export type UserRole = 'CUSTOMER' | 'ADMIN';

export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface RegisterResponse {
  id: Uuid;
  email: string;
  firstName: string;
  lastName: string;
  roles: UserRole[];
}

export interface LoginRequest {
  email: string;
  password: string;
}

/** Response of POST /auth/login and POST /auth/refresh. */
export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

/** Payload of the access token (read without verification, only for the UI). */
export interface AccessTokenClaims {
  sub: Uuid;
  roles: UserRole[];
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

// ---------- User ----------

export interface UserProfile {
  id: Uuid;
  firstName: string;
  lastName: string;
  email: string;
}

export interface UpdateProfileRequest {
  firstName: string;
  lastName: string;
}

export interface AddressRequest {
  street: string;
  city: string;
  postalCode: string;
  countryCode: string;
}

export interface Address extends AddressRequest {
  id: Uuid;
}

// ---------- Cart ----------

export interface CartItem {
  productId: Uuid;
  name: string;
  unitPrice: Money;
  quantity: number;
  subtotal: Money;
}

export interface Cart {
  userId: Uuid;
  currency: Currency;
  items: CartItem[];
  total: Money;
}

/** Response of POST /cart/items and PATCH /cart/items/{productId}. */
export interface CartMutationResponse extends Cart {
  /** false: Inventory was unavailable, stock is checked when the order is placed. */
  inventoryChecked: boolean;
}

export interface AddCartItemRequest {
  productId: Uuid;
  quantity: number;
}

export interface ChangeCartItemRequest {
  quantity: number;
}

// ---------- Product ----------

export type ProductSort = 'NAME' | 'PRICE_ASC' | 'PRICE_DESC' | 'NEWEST';

export interface ProductListQuery extends PageQuery {
  q?: string;
  categoryId?: Uuid;
  minPrice?: Money;
  maxPrice?: Money;
  sort?: ProductSort;
}

export interface Category {
  id: Uuid;
  name: string;
}

export interface ProductSummary {
  id: Uuid;
  name: string;
  price: Money;
  currency: Currency;
  categoryId: Uuid;
  imageUrl: string | null;
}

export interface ProductRating {
  /** null when count is 0. */
  average: number | null;
  count: number;
}

export interface ProductAvailability {
  available: number;
  inStock: boolean;
}

export interface ProductDetail {
  id: Uuid;
  name: string;
  description: string;
  price: Money;
  currency: Currency;
  category: Category;
  imageUrl: string | null;
  /** null: Review is unavailable. */
  rating: ProductRating | null;
  /** null: Inventory is unavailable or has no record for the product. */
  availability: ProductAvailability | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Body of POST /products and PUT /products/{productId}. */
export interface ProductRequest {
  name: string;
  description: string;
  price: Money;
  currency: Currency;
  categoryId: Uuid;
  imageUrl: string | null;
}

// ---------- Inventory ----------

export interface StockLevel {
  productId: Uuid;
  quantity: number;
  reserved: number;
  available: number;
  inStock: boolean;
}

export interface StockUpdateRequest {
  quantity: number;
}

// ---------- Review ----------

export interface Review {
  id: Uuid;
  productId: Uuid;
  userId: Uuid;
  rating: number;
  comment: string | null;
  createdAt: IsoDateTime;
}

export interface ReviewListQuery extends PageQuery {
  productId: Uuid;
}

export interface CreateReviewRequest {
  productId: Uuid;
  rating: number;
  comment: string | null;
}

// ---------- Order ----------

export type OrderStatus = 'NEW' | 'PAID' | 'PAYMENT_FAILED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export type ShippingMethodCode = 'COURIER' | 'PARCEL_LOCKER' | 'PICKUP';

export interface ShippingAddress {
  firstName: string;
  lastName: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
}

export interface PaymentRequest {
  cardNumber: string;
}

export interface CreateOrderRequest {
  shippingMethod: ShippingMethodCode;
  shippingAddress: ShippingAddress;
  payment: PaymentRequest;
}

export interface OrderItem {
  productId: Uuid;
  name: string;
  unitPrice: Money;
  quantity: number;
  subtotal: Money;
}

export interface OrderDetail {
  id: Uuid;
  userId: Uuid;
  status: OrderStatus;
  items: OrderItem[];
  itemsTotal: Money;
  shippingMethod: ShippingMethodCode;
  shippingCost: Money;
  /** itemsTotal + shippingCost. */
  total: Money;
  currency: Currency;
  shippingAddress: ShippingAddress;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface OrderSummary {
  id: Uuid;
  status: OrderStatus;
  total: Money;
  currency: Currency;
  itemCount: number;
  createdAt: IsoDateTime;
}

export type OrderListQuery = PageQuery;

// ---------- Shipping ----------

export type ShipmentStatus = 'PREPARING' | 'SHIPPED' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED';

export interface ShippingMethod {
  code: ShippingMethodCode;
  name: string;
  price: Money;
  currency: Currency;
  estimatedDays: number;
}

export interface ShipmentHistoryEntry {
  status: ShipmentStatus;
  at: IsoDateTime;
}

export interface Shipment {
  id: Uuid;
  orderId: Uuid;
  userId: Uuid;
  status: ShipmentStatus;
  method: ShippingMethodCode;
  /** null until the parcel is handed over (status PREPARING). */
  trackingNumber: string | null;
  /** Oldest first; the last entry equals status. */
  history: ShipmentHistoryEntry[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ShipmentListQuery extends PageQuery {
  orderId?: Uuid;
  status?: ShipmentStatus;
}

export interface ShipmentStatusUpdateRequest {
  status: ShipmentStatus;
}
