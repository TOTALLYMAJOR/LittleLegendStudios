export const ORDER_STATUSES = [
  'draft',
  'awaiting_script_approval',
  'paid',
  'running',
  'delivered',
  'failed',
  'refunded'
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  draft: ['awaiting_script_approval'],
  awaiting_script_approval: ['paid'],
  paid: ['running'],
  running: ['delivered', 'failed'],
  delivered: [],
  failed: ['refunded'],
  refunded: []
};

export function canTransitionOrder(current: OrderStatus, next: OrderStatus): boolean {
  return allowedTransitions[current].includes(next);
}

export function assertOrderTransition(current: OrderStatus, next: OrderStatus): void {
  if (!canTransitionOrder(current, next)) {
    throw new Error(`Invalid order transition: ${current} -> ${next}`);
  }
}
