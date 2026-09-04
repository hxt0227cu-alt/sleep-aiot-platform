CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS scheduled_device_actions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  command TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  execute_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  related_request_id TEXT,
  executed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_device_actions_device_id
  ON scheduled_device_actions(device_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_device_actions_user_id
  ON scheduled_device_actions(user_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_device_actions_status_execute_at
  ON scheduled_device_actions(status, execute_at);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  version TEXT,
  checksum TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  embedding vector,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_chunks_document_id_chunk_index_key UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id
  ON knowledge_chunks(document_id);
