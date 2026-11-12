import type { OrderStatus, ShipmentStatus } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { ORDER_STATUS_LABELS, SHIPMENT_STATUS_LABELS } from '@/lib/labels';

type StatusBadgeProps = { kind: 'order'; status: OrderStatus } | { kind: 'shipment'; status: ShipmentStatus };

const FAILED = new Set<string>(['PAYMENT_FAILED', 'CANCELLED']);
const DONE = new Set<string>(['DELIVERED']);

/** Polish label of an order or shipment status (an unknown status shows its code). */
export function StatusBadge(props: StatusBadgeProps) {
  const label = props.kind === 'order' ? ORDER_STATUS_LABELS[props.status] : SHIPMENT_STATUS_LABELS[props.status];
  const variant = FAILED.has(props.status) ? 'destructive' : DONE.has(props.status) ? 'default' : 'secondary';
  return <Badge variant={variant}>{label ?? props.status}</Badge>;
}
