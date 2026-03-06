import Stripe from 'stripe';

import { env } from './env.js';

const stripeClient = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export function isStripePaymentsEnabled(): boolean {
  return stripeClient !== null;
}

export function canVerifyStripeWebhook(): boolean {
  return stripeClient !== null && Boolean(env.STRIPE_WEBHOOK_SECRET);
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  amountCents: number;
  currency: string;
  parentEmail?: string;
  idempotencyKey?: string;
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<Stripe.Checkout.Session> {
  if (!stripeClient) {
    throw new Error('Stripe is not configured');
  }

  const successUrl = `${env.WEB_APP_BASE_URL}/orders/${input.orderId}?checkout=success`;
  const cancelUrl = `${env.WEB_APP_BASE_URL}/orders/${input.orderId}?checkout=cancel`;

  return stripeClient.checkout.sessions.create(
    {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: input.orderId,
      customer_email: input.parentEmail,
      metadata: {
        orderId: input.orderId
      },
      payment_intent_data: {
        metadata: {
          orderId: input.orderId
        }
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            product_data: {
              name: 'Little Legend Cinematic Keepsake Video',
              description: 'Personalized 20-40 second cinematic child story video'
            }
          }
        }
      ]
    },
    input.idempotencyKey
      ? {
          idempotencyKey: input.idempotencyKey
        }
      : undefined
  );
}

export function constructStripeWebhookEvent(payload: string, signature: string): Stripe.Event {
  if (!stripeClient || !env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook verification is not configured');
  }

  return stripeClient.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
}
