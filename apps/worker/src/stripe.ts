import Stripe from 'stripe';

import { env } from './env.js';

const stripeClient = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export function isStripeRefundEnabled(): boolean {
  return stripeClient !== null;
}

export async function createRefund(params: {
  paymentIntentId: string;
  orderId: string;
  reason: string;
}): Promise<Stripe.Refund> {
  if (!stripeClient) {
    throw new Error('Stripe is not configured');
  }

  return stripeClient.refunds.create({
    payment_intent: params.paymentIntentId,
    metadata: {
      orderId: params.orderId,
      failureReason: params.reason.slice(0, 400)
    }
  });
}

