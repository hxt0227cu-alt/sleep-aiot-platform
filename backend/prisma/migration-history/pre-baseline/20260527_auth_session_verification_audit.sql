CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  login_method TEXT NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'app',
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  device_id TEXT NULL,
  device_name TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  metadata JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id_is_active
  ON auth_sessions(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
  ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS verification_codes (
  verification_code_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone TEXT NOT NULL,
  type TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  invalidated_at TIMESTAMPTZ NULL,
  metadata JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_phone_type_status
  ON verification_codes(phone, type, status);
CREATE INDEX IF NOT EXISTS idx_verification_codes_expires_at
  ON verification_codes(expires_at);

CREATE TABLE IF NOT EXISTS login_audits (
  audit_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NULL REFERENCES users(user_id) ON DELETE SET NULL,
  phone TEXT NULL,
  session_id TEXT NULL REFERENCES auth_sessions(session_id) ON DELETE SET NULL,
  login_method TEXT NOT NULL,
  status TEXT NOT NULL,
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  failure_reason TEXT NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_audits_user_id_created_at
  ON login_audits(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_login_audits_phone_created_at
  ON login_audits(phone, created_at);
CREATE INDEX IF NOT EXISTS idx_login_audits_session_id_created_at
  ON login_audits(session_id, created_at);
