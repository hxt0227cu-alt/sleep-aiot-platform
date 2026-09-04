CREATE TABLE IF NOT EXISTS light_alarms (
  alarm_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  time TEXT NOT NULL,
  mode TEXT NOT NULL,
  brightness_target INTEGER NOT NULL,
  color_temp_target INTEGER NOT NULL,
  ramp_minutes INTEGER NOT NULL DEFAULT 15,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_light_alarms_device_id ON light_alarms(device_id);
CREATE INDEX IF NOT EXISTS idx_light_alarms_user_id ON light_alarms(user_id);

CREATE TABLE IF NOT EXISTS sleep_plans (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  bed_time TEXT NOT NULL,
  sleep_duration DOUBLE PRECISION NOT NULL,
  wake_time TEXT NOT NULL,
  reminder_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sleep_routine_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sleep_routine_records (
  record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NULL,
  steps_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  finished BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sleep_routine_records_user_id ON sleep_routine_records(user_id);
CREATE INDEX IF NOT EXISTS idx_sleep_routine_records_date ON sleep_routine_records(date);

CREATE TABLE IF NOT EXISTS sleep_diaries (
  diary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  device_id UUID NULL REFERENCES devices(device_id) ON DELETE SET NULL,
  date DATE NOT NULL,
  bed_time TEXT NOT NULL,
  wake_time TEXT NOT NULL,
  fall_asleep_minutes INTEGER NOT NULL,
  quality TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sleep_diaries_user_id ON sleep_diaries(user_id);
CREATE INDEX IF NOT EXISTS idx_sleep_diaries_date ON sleep_diaries(date);
CREATE INDEX IF NOT EXISTS idx_sleep_diaries_device_id ON sleep_diaries(device_id);

CREATE TABLE IF NOT EXISTS sleep_relax_records (
  record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  method_id TEXT NOT NULL,
  method_name TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sleep_relax_records_user_id ON sleep_relax_records(user_id);
CREATE INDEX IF NOT EXISTS idx_sleep_relax_records_completed_at ON sleep_relax_records(completed_at);
