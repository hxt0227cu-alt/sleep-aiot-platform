-- TimescaleDB requires every unique key on a hypertable to include its
-- partitioning column. UUID ids remain application-generated identifiers.
ALTER TABLE "vital_signs_data"
  DROP CONSTRAINT "vital_signs_data_pkey",
  ADD CONSTRAINT "vital_signs_data_pkey" PRIMARY KEY ("id", "timestamp");

ALTER TABLE "sleep_state_data"
  DROP CONSTRAINT "sleep_state_data_pkey",
  ADD CONSTRAINT "sleep_state_data_pkey" PRIMARY KEY ("id", "timestamp");
