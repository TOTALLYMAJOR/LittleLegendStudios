import { env } from './env.js';

export type EmailSendStatus = 'sent' | 'failed' | 'stub';

export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendTransactionalEmailResult {
  status: EmailSendStatus;
  provider: 'resend' | 'stub';
  providerMessageId: string | null;
  errorText: string | null;
}

function redactEmail(value: string): string {
  const [local, domain] = value.split('@', 2);
  if (!local || !domain) {
    return value;
  }

  if (local.length <= 2) {
    return `${local[0] ?? '*'}*@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput
): Promise<SendTransactionalEmailResult> {
  if (env.EMAIL_PROVIDER_MODE !== 'resend' || !env.RESEND_API_KEY) {
    process.stdout.write(
      `Email stub: to=${redactEmail(input.to)} subject="${input.subject.slice(0, 80)}"\n`
    );
    return {
      status: 'stub',
      provider: 'stub',
      providerMessageId: null,
      errorText: null
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text
      })
    });

    const rawText = await response.text();
    const payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : {};

    if (!response.ok) {
      const apiError =
        typeof payload.message === 'string' && payload.message.trim().length > 0
          ? payload.message
          : `HTTP ${response.status}`;
      return {
        status: 'failed',
        provider: 'resend',
        providerMessageId: null,
        errorText: `Resend send failed: ${apiError}`
      };
    }

    const providerMessageId = typeof payload.id === 'string' ? payload.id : null;
    if (!providerMessageId) {
      return {
        status: 'failed',
        provider: 'resend',
        providerMessageId: null,
        errorText: 'Resend response missing message id.'
      };
    }

    return {
      status: 'sent',
      provider: 'resend',
      providerMessageId,
      errorText: null
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'resend',
      providerMessageId: null,
      errorText: (error as Error).message
    };
  }
}
