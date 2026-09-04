\set ON_ERROR_STOP on

\if :{?timescale_capability_mode}
SELECT set_config(
  'sleep.timescale_capability_mode',
  :'timescale_capability_mode',
  false
) AS timescale_mode_override
\gset
\endif

DO $timescale_gate$
DECLARE
  requested_mode TEXT := current_setting('sleep.timescale_capability_mode', true);
  license_mode TEXT := lower(coalesce(current_setting('timescaledb.license', true), ''));
  capability_mode TEXT;
  hypertable_count INTEGER;
  continuous_aggregate_count INTEGER;
  retention_policy_count INTEGER;
  compression_policy_count INTEGER;
  refresh_policy_count INTEGER;
  expected_continuous_aggregates INTEGER;
  expected_retention_policies INTEGER;
  expected_compression_policies INTEGER;
  expected_refresh_policies INTEGER;
BEGIN
  capability_mode := CASE
    WHEN requested_mode IN ('full', 'apache-core') THEN requested_mode
    WHEN license_mode = 'apache' THEN 'apache-core'
    ELSE 'full'
  END;
  PERFORM set_config('sleep.timescale_effective_mode', capability_mode, false);

  SELECT count(*) INTO hypertable_count
  FROM timescaledb_information.hypertables
  WHERE hypertable_schema = 'public'
    AND hypertable_name IN ('vital_signs_data', 'sleep_state_data');

  SELECT count(*) INTO continuous_aggregate_count
  FROM timescaledb_information.continuous_aggregates
  WHERE view_schema = 'public'
    AND view_name IN ('vital_signs_1m', 'vital_signs_5m', 'vital_signs_1h');

  SELECT count(*) FILTER (WHERE proc_name = 'policy_retention'),
         count(*) FILTER (WHERE proc_name = 'policy_compression'),
         count(*) FILTER (WHERE proc_name = 'policy_refresh_continuous_aggregate')
    INTO retention_policy_count, compression_policy_count, refresh_policy_count
  FROM timescaledb_information.jobs;

  expected_continuous_aggregates := CASE WHEN capability_mode = 'full' THEN 3 ELSE 0 END;
  expected_retention_policies := CASE WHEN capability_mode = 'full' THEN 5 ELSE 0 END;
  expected_compression_policies := CASE WHEN capability_mode = 'full' THEN 2 ELSE 0 END;
  expected_refresh_policies := CASE WHEN capability_mode = 'full' THEN 3 ELSE 0 END;

  IF hypertable_count <> 2
     OR continuous_aggregate_count <> expected_continuous_aggregates
     OR retention_policy_count <> expected_retention_policies
     OR compression_policy_count <> expected_compression_policies
     OR refresh_policy_count <> expected_refresh_policies THEN
    RAISE EXCEPTION
      'TimescaleDB % gate failed: hypertables=%, continuous_aggregates=%, retention=%, compression=%, refresh=%',
      capability_mode,
      hypertable_count,
      continuous_aggregate_count,
      retention_policy_count,
      compression_policy_count,
      refresh_policy_count;
  END IF;
END
$timescale_gate$;

SELECT json_build_object(
  'capabilityMode', current_setting('sleep.timescale_effective_mode'),
  'license', current_setting('timescaledb.license', true),
  'hypertables', (
    SELECT count(*)::int FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'public'
      AND hypertable_name IN ('vital_signs_data', 'sleep_state_data')
  ),
  'continuousAggregates', (
    SELECT count(*)::int FROM timescaledb_information.continuous_aggregates
    WHERE view_schema = 'public'
      AND view_name IN ('vital_signs_1m', 'vital_signs_5m', 'vital_signs_1h')
  ),
  'retentionPolicies', (
    SELECT count(*)::int FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'
  ),
  'compressionPolicies', (
    SELECT count(*)::int FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'
  ),
  'refreshPolicies', (
    SELECT count(*)::int FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'
  )
);
