// Mock Shipping (contract: docs/frontend-api.md, section Shipping). A status change does what the event
// shipment.status_changed does in Order (order status) and Inventory (stock issued at SHIPPED).
import type { Shipment, ShipmentStatus } from '../../api/types';
import type { MockShipment } from '../db';
import { isAdmin, json, MockApiError, notFound, now, requireIdentity, route } from '../http';
import { newestFirst, oneOf, pageOf, pageRequest, pathUuid, readBody, uuid } from '../validation';

const STATUSES: readonly ShipmentStatus[] = ['PREPARING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'];
const NEXT: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
  PREPARING: 'SHIPPED',
  SHIPPED: 'IN_TRANSIT',
  IN_TRANSIT: 'DELIVERED',
};

const view = (s: MockShipment): Shipment => ({
  id: s.id,
  orderId: s.orderId,
  userId: s.userId,
  status: s.status,
  method: s.method,
  trackingNumber: s.trackingNumber,
  history: s.history.map((h) => ({ ...h })),
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/**
 * Applies a cancellation planned by the mock Order (order.cancelled) once its time has come; called before
 * every read or change of shipments, so it works without timers and survives a page reload.
 */
export function applyPlannedCancel(shipment: MockShipment, timestamp: string): void {
  if (shipment.cancelAt === undefined || shipment.cancelAt > timestamp) return;
  if (shipment.status === 'PREPARING') {
    shipment.status = 'CANCELLED';
    shipment.history.push({ status: 'CANCELLED', at: shipment.cancelAt });
    shipment.updatedAt = shipment.cancelAt;
  }
  delete shipment.cancelAt;
}

const trackingNumber = (): string => `PL${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;

export const shippingHandlers = [
  route('GET', '/shipping/methods', ({ state }) => json(state.shippingMethods)),

  route('GET', '/shipments', (ctx) => {
    const identity = requireIdentity(ctx);
    const { url } = ctx;
    const orderId = url.searchParams.has('orderId') ? uuid(url.searchParams.get('orderId'), 'orderId') : null;
    const status = url.searchParams.has('status') ? oneOf(url.searchParams.get('status'), 'status', STATUSES) : null;
    const paging = pageRequest(url);
    const timestamp = now();
    ctx.state.shipments.forEach((s) => applyPlannedCancel(s, timestamp));
    const found = ctx.state.shipments.filter(
      (s) =>
        s.visibleAt <= timestamp &&
        (isAdmin(identity) || s.userId === identity.userId) &&
        (orderId === null || s.orderId === orderId) &&
        (status === null || s.status === status),
    );
    return json(pageOf(newestFirst(found).map(view), paging));
  }),

  route('PATCH', '/shipments/:shipmentId/status', (ctx) => {
    const shipmentId = pathUuid(ctx.params, 'shipmentId');
    const body = readBody(ctx.body, ['status']);
    const target = oneOf(body.status, 'status', STATUSES);
    const { state } = ctx;
    const shipment = state.shipments.find((s) => s.id === shipmentId);
    if (!shipment) {
      throw notFound('Shipment not found');
    }
    applyPlannedCancel(shipment, now());
    if (NEXT[shipment.status] !== target) {
      throw new MockApiError(409, 'INVALID_STATUS_TRANSITION', `Cannot change ${shipment.status} to ${target}`);
    }
    const timestamp = now();
    shipment.status = target;
    shipment.history.push({ status: target, at: timestamp });
    shipment.updatedAt = timestamp;
    const order = state.orders.find((o) => o.id === shipment.orderId);
    if (target === 'SHIPPED') {
      shipment.trackingNumber = trackingNumber();
      order?.items.forEach((item) => {
        const stock = state.stock[item.productId];
        if (stock) {
          stock.quantity = Math.max(0, stock.quantity - item.quantity);
          stock.reserved = Math.max(0, stock.reserved - item.quantity);
        }
      });
    }
    if (order && (target === 'SHIPPED' || target === 'DELIVERED')) {
      order.status = target;
      order.updatedAt = timestamp;
    }
    return json(view(shipment));
  }),
];
