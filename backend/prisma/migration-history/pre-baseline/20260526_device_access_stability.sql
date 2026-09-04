CREATE TABLE IF NOT EXISTS device_provision_tokens (
  provision_token_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id TEXT NULL REFERENCES devices(device_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata JSONB NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_provision_tokens_user_id
  ON device_provision_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_provision_tokens_device_id
  ON device_provision_tokens(device_id);
CREATE INDEX IF NOT EXISTS idx_device_provision_tokens_status
  ON device_provision_tokens(status);
CREATE INDEX IF NOT EXISTS idx_device_provision_tokens_expires_at
  ON device_provision_tokens(expires_at);

CREATE TABLE IF NOT EXISTS device_binding_sessions (
  binding_session_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NULL REFERENCES users(user_id) ON DELETE SET NULL,
  device_id TEXT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  provision_token_id TEXT NULL UNIQUE REFERENCES device_provision_tokens(provision_token_id) ON DELETE SET NULL,
  binding_code TEXT NULL,
  session_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_metadata JSONB NULL,
  expires_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  unbound_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_user_id
  ON device_binding_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_device_id
  ON device_binding_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_binding_code
  ON device_binding_sessions(binding_code);
CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_session_type
  ON device_binding_sessions(session_type);
CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_status
  ON device_binding_sessions(status);
CREATE INDEX IF NOT EXISTS idx_device_binding_sessions_expires_at
  ON device_binding_sessions(expires_at);

CREATE TABLE IF NOT EXISTS device_command_records (
  command_record_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  command_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  params JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  topic TEXT NOT NULL,
  response JSONB NULL,
  error_message TEXT NULL,
  timeout_ms INTEGER NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_command_records_device_id
  ON device_command_records(device_id);
CREATE INDEX IF NOT EXISTS idx_device_command_records_user_id
  ON device_command_records(user_id);
CREATE INDEX IF NOT EXISTS idx_device_command_records_status
  ON device_command_records(status);
CREATE INDEX IF NOT EXISTS idx_device_command_records_sent_at
  ON device_command_records(sent_at);
