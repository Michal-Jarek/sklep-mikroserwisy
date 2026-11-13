// Seed data of the mock services. Identifiers are fixed, so tests and E2E can refer to them (SEED_IDS).
import type { OrderDetail, Review, ShippingAddress } from '../api/types';
import type { MockProduct, MockShipment, MockState, MockStock } from './db';
import { toMoney } from './money';

const id = (prefix: string, n: number): string =>
  `${prefix}-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Passwords for the mock accounts only (documented in the frontend README). Not secrets. */
export const MOCK_ACCOUNTS = {
  customer: { email: 'klient@sklep.test', password: 'Klient-atrapa-1' },
  admin: { email: 'admin@sklep.test', password: 'Admin-atrapa-1' },
} as const;

export const SEED_IDS = {
  customer: id('b0000000', 1),
  admin: id('b0000000', 2),
  categories: {
    kitchen: id('c0000000', 1),
    books: id('c0000000', 2),
    electronics: id('c0000000', 3),
    garden: id('c0000000', 4),
  },
  products: {
    /** Regular product: stock 50, 12 reviews (one by the customer, so a second review gives 409). */
    regular: id('a0000000', 1),
    /** rating: null (Review "unavailable"). */
    ratingUnavailable: id('a0000000', 2),
    /** rating.count 0, rating.average null. */
    noReviews: id('a0000000', 3),
    /** No stock record = 0 pieces: availability {available: 0, inStock: false}, cart 409, order INSUFFICIENT_STOCK. */
    noStock: id('a0000000', 4),
    /** availability.inStock false (quantity 0). */
    outOfStock: id('a0000000', 5),
    /** Bought by the customer (delivered order), not reviewed yet: a review is accepted. */
    purchased: id('a0000000', 6),
    /** Only 2 pieces in stock: adding 3 gives 409. */
    lowStock: id('a0000000', 7),
    /** availability: null (Inventory "unavailable") — cart answers inventoryChecked:false. */
    inventoryUnavailable: id('a0000000', 8),
  },
  orders: {
    /** DELIVERED, shipment DELIVERED. */
    delivered: id('d0000000', 1),
    /** SHIPPED, shipment SHIPPED: cancel gives ORDER_NOT_CANCELLABLE. */
    shipped: id('d0000000', 2),
    /** PAID, shipment PREPARING: can be cancelled. */
    paid: id('d0000000', 3),
    /** PAYMENT_FAILED, no shipment. */
    paymentFailed: id('d0000000', 4),
  },
  shipments: {
    delivered: id('e0000000', 1),
    shipped: id('e0000000', 2),
    preparing: id('e0000000', 3),
  },
  address: id('ad000000', 1),
} as const;

function placeholderImage(label: string, color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">` +
    `<rect width="400" height="300" fill="${color}"/>` +
    `<text x="200" y="160" font-family="sans-serif" font-size="28" fill="#ffffff" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const day = (date: string): string => `${date}T10:00:00.000Z`;

interface ProductSeed {
  name: string;
  priceCents: number;
  category: keyof typeof SEED_IDS.categories;
  description: string;
  image: string | null;
  stock: MockStock | null;
  ratingUnavailable?: boolean;
  inventoryUnavailable?: boolean;
}

const PRODUCTS: ProductSeed[] = [
  { name: 'Kubek ceramiczny', priceCents: 1999, category: 'kitchen', description: 'Kubek 300 ml, można myć w zmywarce.', image: '#b45309', stock: { quantity: 50, reserved: 0 } },
  { name: 'Czajnik elektryczny', priceCents: 12900, category: 'kitchen', description: 'Czajnik 1,7 l ze stali nierdzewnej.', image: '#1d4ed8', stock: { quantity: 15, reserved: 0 }, ratingUnavailable: true },
  { name: 'Deska do krojenia', priceCents: 4990, category: 'kitchen', description: 'Deska z drewna bukowego, 40 × 25 cm.', image: '#92400e', stock: { quantity: 30, reserved: 0 } },
  { name: 'Młynek do kawy', priceCents: 8999, category: 'kitchen', description: 'Ręczny młynek z żarnami ceramicznymi.', image: '#44403c', stock: null },
  { name: 'Patelnia żeliwna', priceCents: 15900, category: 'kitchen', description: 'Patelnia 28 cm do kuchni indukcyjnej.', image: '#18181b', stock: { quantity: 0, reserved: 0 } },
  { name: 'Termos stalowy', priceCents: 5999, category: 'kitchen', description: 'Termos 750 ml, trzyma ciepło 12 godzin.', image: '#0f766e', stock: { quantity: 20, reserved: 0 } },
  { name: 'Mikroserwisy w praktyce', priceCents: 7900, category: 'books', description: 'Projektowanie i wdrażanie systemów z wielu usług.', image: '#7c3aed', stock: { quantity: 2, reserved: 0 } },
  { name: 'Wzorce projektowe', priceCents: 9900, category: 'books', description: 'Klasyczne wzorce z przykładami.', image: '#6d28d9', stock: { quantity: 12, reserved: 0 }, inventoryUnavailable: true },
  { name: 'Czysty kod', priceCents: 6990, category: 'books', description: 'Jak pisać kod czytelny dla innych.', image: null, stock: { quantity: 10, reserved: 1 } },
  { name: 'Algorytmy', priceCents: 11900, category: 'books', description: 'Algorytmy i struktury danych od podstaw.', image: '#4338ca', stock: { quantity: 8, reserved: 0 } },
  { name: 'Sieci komputerowe', priceCents: 8900, category: 'books', description: 'Protokoły, adresacja i bezpieczeństwo sieci.', image: null, stock: { quantity: 6, reserved: 0 } },
  { name: 'Bazy danych', priceCents: 7450, category: 'books', description: 'Modelowanie danych i SQL.', image: '#5b21b6', stock: { quantity: 9, reserved: 0 } },
  { name: 'Słuchawki bezprzewodowe', priceCents: 24999, category: 'electronics', description: 'Słuchawki z redukcją szumów, 30 godzin pracy.', image: '#0f172a', stock: { quantity: 5, reserved: 0 } },
  { name: 'Mysz komputerowa', priceCents: 5900, category: 'electronics', description: 'Mysz bezprzewodowa, 6 przycisków.', image: '#334155', stock: { quantity: 40, reserved: 0 } },
  { name: 'Klawiatura mechaniczna', priceCents: 29900, category: 'electronics', description: 'Klawiatura z przełącznikami brązowymi.', image: '#1e293b', stock: { quantity: 7, reserved: 0 } },
  { name: 'Ładowarka USB-C', priceCents: 3999, category: 'electronics', description: 'Ładowarka 65 W z jednym portem USB-C.', image: null, stock: { quantity: 60, reserved: 0 } },
  { name: 'Powerbank 10000 mAh', priceCents: 8900, category: 'electronics', description: 'Powerbank z szybkim ładowaniem.', image: '#475569', stock: { quantity: 25, reserved: 0 } },
  { name: 'Kabel HDMI 2 m', priceCents: 2499, category: 'electronics', description: 'Kabel HDMI 2.1 o długości 2 m.', image: '#64748b', stock: { quantity: 100, reserved: 0 } },
  { name: 'Konewka 10 l', priceCents: 3499, category: 'garden', description: 'Konewka z tworzywa z sitkiem.', image: '#15803d', stock: { quantity: 18, reserved: 0 } },
  { name: 'Sekator', priceCents: 5490, category: 'garden', description: 'Sekator nożycowy do gałęzi do 20 mm.', image: '#166534', stock: { quantity: 14, reserved: 0 } },
  { name: 'Rękawice ogrodowe', priceCents: 1990, category: 'garden', description: 'Rękawice powlekane lateksem, rozmiar M.', image: null, stock: { quantity: 70, reserved: 0 } },
  { name: 'Leżak składany', priceCents: 14900, category: 'garden', description: 'Leżak z drewna akacjowego.', image: '#a16207', stock: { quantity: 4, reserved: 0 } },
  { name: 'Doniczka ceramiczna', priceCents: 2999, category: 'garden', description: 'Doniczka 18 cm z podstawką.', image: '#c2410c', stock: { quantity: 35, reserved: 0 } },
  { name: 'Nasiona ziół', priceCents: 999, category: 'garden', description: 'Zestaw nasion: bazylia, mięta, tymianek.', image: '#4d7c0f', stock: { quantity: 120, reserved: 0 } },
];

const REVIEW_COMMENTS = [
  'Solidny, polecam.',
  'Dobra jakość w tej cenie.',
  null,
  'Szybka dostawa, produkt zgodny z opisem.',
  'Mogłoby być lepiej.',
  null,
  'Używam codziennie.',
];

const CUSTOMER_ADDRESS: ShippingAddress = {
  firstName: 'Jan',
  lastName: 'Kowalski',
  street: 'ul. Testowa 1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
};

function reviewsFor(productIndex: number, count: number, firstReviewNumber: number): Review[] {
  const reviews: Review[] = [];
  for (let i = 0; i < count; i += 1) {
    reviews.push({
      id: id('f0000000', firstReviewNumber + i),
      productId: id('a0000000', productIndex),
      userId: id('b0000000', 100 + i),
      rating: [5, 4, 5, 3, 4, 2, 5][i % 7],
      comment: REVIEW_COMMENTS[i % REVIEW_COMMENTS.length],
      createdAt: `2026-10-${(10 + i).toString().padStart(2, '0')}T12:00:00.000Z`,
    });
  }
  return reviews;
}

function order(
  orderId: string,
  status: OrderDetail['status'],
  createdAt: string,
  lines: { productIndex: number; quantity: number }[],
  shippingMethod: OrderDetail['shippingMethod'],
  shippingCostCents: number,
  updatedAt = createdAt,
): OrderDetail {
  const items = lines.map(({ productIndex, quantity }) => {
    const product = PRODUCTS[productIndex - 1];
    return {
      productId: id('a0000000', productIndex),
      name: product.name,
      unitPrice: toMoney(product.priceCents),
      quantity,
      subtotal: toMoney(product.priceCents * quantity),
    };
  });
  const itemsCents = lines.reduce((sum, { productIndex, quantity }) => sum + PRODUCTS[productIndex - 1].priceCents * quantity, 0);
  return {
    id: orderId,
    userId: SEED_IDS.customer,
    status,
    items,
    itemsTotal: toMoney(itemsCents),
    shippingMethod,
    shippingCost: toMoney(shippingCostCents),
    total: toMoney(itemsCents + shippingCostCents),
    currency: 'PLN',
    shippingAddress: { ...CUSTOMER_ADDRESS },
    createdAt,
    updatedAt,
  };
}

function shipment(
  shipmentId: string,
  source: OrderDetail,
  history: MockShipment['history'],
  trackingNumber: string | null,
): MockShipment {
  const last = history[history.length - 1];
  return {
    id: shipmentId,
    orderId: source.id,
    userId: source.userId,
    status: last.status,
    method: source.shippingMethod,
    trackingNumber,
    history,
    createdAt: history[0].at,
    updatedAt: last.at,
    visibleAt: history[0].at,
  };
}

export function createSeed(): MockState {
  const products: MockProduct[] = PRODUCTS.map((p, index) => ({
    id: id('a0000000', index + 1),
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    categoryId: SEED_IDS.categories[p.category],
    imageUrl: p.image === null ? null : placeholderImage(p.name, p.image),
    createdAt: day(`2026-10-${(index + 1).toString().padStart(2, '0')}`),
    updatedAt: day(`2026-10-${(index + 1).toString().padStart(2, '0')}`),
    ...(p.ratingUnavailable ? { ratingUnavailable: true } : {}),
    ...(p.inventoryUnavailable ? { inventoryUnavailable: true } : {}),
  }));

  const stock: MockState['stock'] = {};
  PRODUCTS.forEach((p, index) => {
    if (p.stock !== null) {
      stock[id('a0000000', index + 1)] = { ...p.stock };
    }
  });

  const reviews: Review[] = [
    ...reviewsFor(1, 11, 1),
    {
      id: id('f0000000', 50),
      productId: SEED_IDS.products.regular,
      userId: SEED_IDS.customer,
      rating: 4,
      comment: 'Kubek jak na zdjęciu.',
      createdAt: '2026-10-25T09:00:00.000Z',
    },
    ...reviewsFor(2, 3, 20),
    ...reviewsFor(10, 2, 30),
    ...reviewsFor(13, 4, 40),
  ];

  const delivered = order(SEED_IDS.orders.delivered, 'DELIVERED', '2026-10-20T08:00:00.000Z',
    [{ productIndex: 1, quantity: 2 }, { productIndex: 6, quantity: 1 }], 'COURIER', 1499, '2026-10-23T14:00:00.000Z');
  const shipped = order(SEED_IDS.orders.shipped, 'SHIPPED', '2026-11-02T08:00:00.000Z',
    [{ productIndex: 8, quantity: 1 }], 'PARCEL_LOCKER', 999, '2026-11-03T09:00:00.000Z');
  const paid = order(SEED_IDS.orders.paid, 'PAID', '2026-11-08T08:00:00.000Z',
    [{ productIndex: 9, quantity: 1 }], 'PICKUP', 0);
  const paymentFailed = order(SEED_IDS.orders.paymentFailed, 'PAYMENT_FAILED', '2026-10-15T08:00:00.000Z',
    [{ productIndex: 14, quantity: 1 }], 'COURIER', 1499);

  return {
    accounts: [
      { id: SEED_IDS.customer, ...MOCK_ACCOUNTS.customer, firstName: 'Jan', lastName: 'Kowalski', roles: ['CUSTOMER'] },
      { id: SEED_IDS.admin, ...MOCK_ACCOUNTS.admin, firstName: 'Ada', lastName: 'Administrator', roles: ['ADMIN'] },
    ],
    profiles: [{ id: SEED_IDS.customer, firstName: 'Jan', lastName: 'Kowalski', email: MOCK_ACCOUNTS.customer.email }],
    addresses: [
      { id: SEED_IDS.address, userId: SEED_IDS.customer, street: 'ul. Testowa 1', city: 'Warszawa', postalCode: '00-001', countryCode: 'PL' },
    ],
    carts: {},
    categories: [
      { id: SEED_IDS.categories.kitchen, name: 'Kuchnia' },
      { id: SEED_IDS.categories.books, name: 'Książki' },
      { id: SEED_IDS.categories.electronics, name: 'Elektronika' },
      { id: SEED_IDS.categories.garden, name: 'Ogród' },
    ],
    products,
    stock,
    reviews,
    shippingMethods: [
      { code: 'COURIER', name: 'Kurier', price: '14.99', currency: 'PLN', estimatedDays: 2 },
      { code: 'PARCEL_LOCKER', name: 'Paczkomat', price: '9.99', currency: 'PLN', estimatedDays: 2 },
      { code: 'PICKUP', name: 'Odbiór osobisty', price: '0.00', currency: 'PLN', estimatedDays: 1 },
    ],
    orders: [delivered, shipped, paid, paymentFailed],
    shipments: [
      shipment(SEED_IDS.shipments.delivered, delivered, [
        { status: 'PREPARING', at: '2026-10-20T08:00:01.000Z' },
        { status: 'SHIPPED', at: '2026-10-21T09:00:00.000Z' },
        { status: 'IN_TRANSIT', at: '2026-10-21T18:00:00.000Z' },
        { status: 'DELIVERED', at: '2026-10-23T14:00:00.000Z' },
      ], 'PL0000000001'),
      shipment(SEED_IDS.shipments.shipped, shipped, [
        { status: 'PREPARING', at: '2026-11-02T08:00:01.000Z' },
        { status: 'SHIPPED', at: '2026-11-03T09:00:00.000Z' },
      ], 'PL0000000002'),
      shipment(SEED_IDS.shipments.preparing, paid, [
        { status: 'PREPARING', at: '2026-11-08T08:00:01.000Z' },
      ], null),
    ],
    session: null,
    failures: {},
  };
}
