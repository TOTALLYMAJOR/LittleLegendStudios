export const ORDER_STATUSES = [
  'draft',
  'intake_validating',
  'needs_user_fix',
  'awaiting_script_approval',
  'script_regenerate',
  'payment_pending',
  'paid',
  'running',
  'failed_soft',
  'failed_hard',
  'refund_queued',
  'manual_review',
  'delivered',
  'refunded',
  'expired'
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  draft: ['intake_validating'],
  intake_validating: ['awaiting_script_approval', 'needs_user_fix'],
  needs_user_fix: ['intake_validating'],
  awaiting_script_approval: ['script_regenerate', 'payment_pending'],
  script_regenerate: ['awaiting_script_approval'],
  payment_pending: ['paid', 'awaiting_script_approval'],
  paid: ['running'],
  running: ['delivered', 'failed_soft', 'failed_hard', 'manual_review'],
  failed_soft: ['running', 'failed_hard'],
  failed_hard: ['refund_queued', 'failed_soft'],
  refund_queued: ['refunded', 'manual_review'],
  manual_review: ['refunded', 'failed_soft'],
  delivered: ['expired'],
  refunded: [],
  expired: []
};

export function canTransitionOrder(current: OrderStatus, next: OrderStatus): boolean {
  return allowedTransitions[current].includes(next);
}

export function assertOrderTransition(current: OrderStatus, next: OrderStatus): void {
  if (!canTransitionOrder(current, next)) {
    throw new Error(`Invalid order transition: ${current} -> ${next}`);
  }
}
