CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip INET,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  duration_min_sec INT NOT NULL,
  duration_max_sec INT NOT NULL,
  template_manifest_json JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  theme_id UUID NOT NULL REFERENCES themes(id),
  status TEXT NOT NULL CHECK (
    status IN (
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
    )
  ),
  currency TEXT NOT NULL DEFAULT 'usd',
  amount_cents INT NOT NULL,
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS character_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  source_photo_fingerprint TEXT NOT NULL,
  source_photo_count INT NOT NULL,
  latest_order_id UUID REFERENCES orders(id),
  version INT NOT NULL DEFAULT 1,
  character_profile_json JSONB NOT NULL,
  refs_meta_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_photo_fingerprint)
);

CREATE TABLE IF NOT EXISTS uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'voice')),
  s3_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  version INT NOT NULL,
  script_json JSONB NOT NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id, version)
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL CHECK (
    type IN ('moderation', 'voice_clone', 'voice_render', 'character_pack', 'shot_render', 'final_render', 'refund')
  ),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt INT NOT NULL DEFAULT 1,
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_text TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'voice_clone_meta',
      'audio_narration',
      'audio_dialogue',
      'character_refs',
      'shot_video',
      'final_video',
      'thumbnail',
      'preview_video'
    )
  ),
  s3_key TEXT NOT NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_task_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  order_id UUID REFERENCES orders(id),
  job_type TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  artifact_key TEXT,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_text TEXT,
  last_polled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_retry_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  actor TEXT NOT NULL CHECK (actor IN ('parent', 'admin')),
  requested_status TEXT NOT NULL,
  accepted BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_case_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moderation_job_id UUID NOT NULL REFERENCES jobs(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  action TEXT NOT NULL CHECK (action IN ('approve_override', 'reject_override')),
  note TEXT NOT NULL,
  actor TEXT NOT NULL,
  previous_order_status TEXT NOT NULL,
  resulting_order_status TEXT NOT NULL,
  previous_decision TEXT NOT NULL CHECK (previous_decision IN ('pass', 'manual_review', 'reject', 'unknown')),
  resulting_decision TEXT NOT NULL CHECK (resulting_decision IN ('pass', 'manual_review', 'reject', 'unknown')),
  retry_request_id UUID REFERENCES order_retry_requests(id),
  retry_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_redemption_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  recipient_email TEXT NOT NULL,
  sender_name TEXT,
  gift_message TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  token_encrypted TEXT,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')) DEFAULT 'pending',
  redeemed_by_user_id UUID REFERENCES users(id),
  redeemed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  recipient_email TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('delivery_ready', 'render_failed', 'gift_redeem_link')),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'stub')),
  subject TEXT NOT NULL,
  error_text TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_data_purge_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('manual_parent', 'manual_admin', 'retention_sweep')),
  actor TEXT CHECK (actor IN ('parent', 'admin')),
  previous_order_status TEXT NOT NULL,
  resulting_order_status TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  deleted_asset_count INT NOT NULL DEFAULT 0,
  provider_deletion_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  retention_window_days INT,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')) DEFAULT 'in_progress',
  response_json JSONB,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS render_enqueue_dedupes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  dedupe_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, dedupe_key)
);

ALTER TABLE gift_redemption_links
ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  delivery_count INT NOT NULL DEFAULT 1,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

UPDATE orders
SET status = 'failed_hard'
WHERE status = 'failed';

ALTER TABLE orders
DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
ADD CONSTRAINT orders_status_check CHECK (
  status IN (
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
  )
);

ALTER TABLE jobs
DROP CONSTRAINT IF EXISTS jobs_type_check;

ALTER TABLE jobs
ADD CONSTRAINT jobs_type_check CHECK (
  type IN ('moderation', 'voice_clone', 'voice_render', 'character_pack', 'shot_render', 'final_render', 'refund')
);

ALTER TABLE artifacts
DROP CONSTRAINT IF EXISTS artifacts_kind_check;

ALTER TABLE artifacts
ADD CONSTRAINT artifacts_kind_check CHECK (
  kind IN (
    'voice_clone_meta',
    'audio_narration',
    'audio_dialogue',
    'character_refs',
    'shot_video',
    'final_video',
    'thumbnail',
    'preview_video'
  )
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_character_identities_user_id ON character_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_character_identities_last_used_at ON character_identities(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_order_id ON uploads(order_id);
CREATE INDEX IF NOT EXISTS idx_scripts_order_id ON scripts(order_id);
CREATE INDEX IF NOT EXISTS idx_jobs_order_id ON jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_order_id ON artifacts(order_id);
CREATE INDEX IF NOT EXISTS idx_provider_tasks_order_id ON provider_tasks(order_id);
CREATE INDEX IF NOT EXISTS idx_provider_tasks_status ON provider_tasks(status);
CREATE INDEX IF NOT EXISTS idx_order_retry_requests_order_id ON order_retry_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_moderation_case_actions_order_id ON moderation_case_actions(order_id);
CREATE INDEX IF NOT EXISTS idx_moderation_case_actions_job_id ON moderation_case_actions(moderation_job_id);
CREATE INDEX IF NOT EXISTS idx_moderation_case_actions_created_at ON moderation_case_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_redemption_links_order_id ON gift_redemption_links(order_id);
CREATE INDEX IF NOT EXISTS idx_gift_redemption_links_status ON gift_redemption_links(status);
CREATE INDEX IF NOT EXISTS idx_email_notifications_order_id ON email_notifications(order_id);
CREATE INDEX IF NOT EXISTS idx_order_data_purge_events_order_id ON order_data_purge_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_data_purge_events_created_at ON order_data_purge_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_data_purge_events_outcome ON order_data_purge_events(outcome);
CREATE INDEX IF NOT EXISTS idx_payment_idempotency_order_id ON payment_idempotency_keys(order_id);
CREATE INDEX IF NOT EXISTS idx_render_enqueue_dedupes_order_id ON render_enqueue_dedupes(order_id);
CREATE INDEX IF NOT EXISTS idx_render_enqueue_dedupes_created_at ON render_enqueue_dedupes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_status ON stripe_webhook_events(status);
