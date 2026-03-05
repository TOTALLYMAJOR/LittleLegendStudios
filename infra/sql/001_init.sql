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
  kind TEXT NOT NULL CHECK (kind IN ('voice_clone_meta', 'audio_narration', 'audio_dialogue', 'character_refs', 'shot_video', 'final_video', 'thumbnail')),
  s3_key TEXT NOT NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_uploads_order_id ON uploads(order_id);
CREATE INDEX IF NOT EXISTS idx_scripts_order_id ON scripts(order_id);
CREATE INDEX IF NOT EXISTS idx_jobs_order_id ON jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_order_id ON artifacts(order_id);
