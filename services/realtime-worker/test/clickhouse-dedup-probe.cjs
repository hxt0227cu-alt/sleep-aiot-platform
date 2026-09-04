const { createClient } = require('@clickhouse/client');

const eventId = required('EVENT_ID');
const client = createClient({
  url: process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
  username: process.env.CLICKHOUSE_USER || 'sleep',
  password: required('CLICKHOUSE_PASSWORD'),
  database: process.env.CLICKHOUSE_DB || 'sleep_warehouse',
});

async function query(query, queryParams) {
  const result = await client.query({
    query,
    query_params: queryParams,
    format: 'JSONEachRow',
  });
  return result.json();
}

async function main() {
  try {
    const results = await Promise.allSettled([
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE event_id IN ({event_ids:Array(UUID)})',
        { event_ids: [eventId] },
      ),
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE event_id = {event_id:UUID}',
        { event_id: eventId },
      ),
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE toString(event_id) IN ({event_ids:Array(String)})',
        { event_ids: [eventId] },
      ),
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE event_id IN arrayMap(value -> toUUID(value), {event_ids:Array(String)})',
        { event_ids: [eventId] },
      ),
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE has(arrayMap(value -> toUUID(value), {event_ids:Array(String)}), event_id)',
        { event_ids: [eventId] },
      ),
      query(
        'SELECT toString(event_id) AS event_id FROM raw.device_telemetry WHERE event_id IN (SELECT arrayJoin(arrayMap(value -> toUUID(value), {event_ids:Array(String)})))',
        { event_ids: [eventId] },
      ),
    ]);
    console.log(JSON.stringify({
      eventId,
      arrayUuid: settled(results[0]),
      scalarUuid: settled(results[1]),
      arrayString: settled(results[2]),
      convertedUuidArray: settled(results[3]),
      convertedUuidHas: settled(results[4]),
      convertedUuidSubquery: settled(results[5]),
    }, null, 2));
  } finally {
    await client.close();
  }
}

function settled(result) {
  return result.status === 'fulfilled'
    ? { ok: true, rows: result.value }
    : { ok: false, error: result.reason?.message || String(result.reason) };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
