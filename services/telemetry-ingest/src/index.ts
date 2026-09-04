import { createServer } from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import mqtt from 'mqtt';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { compileTelemetrySchema } from './telemetry-schema';
import { registerJsonSchema, RegisteredSchema } from './schema-registry';

const mqttUrl = required('MQTT_BROKER_URL');
const brokers = required('KAFKA_BROKERS').split(',');
const kafkaTopic = process.env.KAFKA_TELEMETRY_TOPIC || 'telemetry.device.v1';
const metricsPort = Number(process.env.METRICS_PORT || 9102);
const schemaPath = process.env.TELEMETRY_SCHEMA_PATH ||
  resolve(process.cwd(), '../../platform/data-contracts/device-telemetry.v1.schema.json');
const eventSchemaPath = process.env.TELEMETRY_EVENT_SCHEMA_PATH ||
  resolve(process.cwd(), '../../platform/data-contracts/device-telemetry-received.v1.schema.json');
const schemaRegistryUrl = required('SCHEMA_REGISTRY_URL');
const schemaRegistrySubject =
  process.env.SCHEMA_REGISTRY_SUBJECT || 'telemetry.device.v1-value';

const validate = compileTelemetrySchema(schemaPath);
const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'sleep_ingest_' });
const received = new Counter({
  name: 'sleep_ingest_messages_total',
  help: 'MQTT messages received by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
const publishDuration = new Histogram({
  name: 'sleep_ingest_kafka_publish_duration_seconds',
  help: 'Kafka publication latency',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});
const ready = new Gauge({
  name: 'sleep_ingest_ready',
  help: 'Whether MQTT and Kafka dependencies are ready',
  registers: [registry],
});
const schemaRegistration = new Gauge({
  name: 'sleep_ingest_schema_registration_info',
  help: 'Registered internal event Schema identity',
  labelNames: ['subject', 'schema_id', 'schema_version'] as const,
  registers: [registry],
});

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || 'telemetry-ingest',
  brokers,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 300, retries: 8 },
});
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,
  maxInFlightRequests: 1,
});
let kafkaReady = false;
let mqttReady = false;
let schemaRegistryReady = false;
let registeredSchema: RegisteredSchema | undefined;

async function start() {
  registeredSchema = await registerJsonSchema(
    schemaRegistryUrl,
    schemaRegistrySubject,
    readFileSync(eventSchemaPath, 'utf8'),
  );
  schemaRegistryReady = true;
  schemaRegistration.set({
    subject: registeredSchema.subject,
    schema_id: String(registeredSchema.id),
    schema_version: String(registeredSchema.version),
  }, 1);
  await producer.connect();
  kafkaReady = true;
  updateReady();

  const mqttClient = mqtt.connect(mqttUrl, {
    clientId: `telemetry-ingest-${process.env.HOSTNAME || process.pid}`,
    clean: process.env.MQTT_CLEAN_SESSION !== 'false',
    reconnectPeriod: 1000,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  });

  mqttClient.on('connect', () => {
    mqttClient.subscribe(
      '$share/telemetry-ingest/device/+/telemetry',
      { qos: 1 },
      (error) => {
        mqttReady = !error;
        updateReady();
        if (error) console.error('MQTT shared subscription failed', error);
      },
    );
  });
  mqttClient.on('offline', () => {
    mqttReady = false;
    updateReady();
  });
  mqttClient.on('close', () => {
    mqttReady = false;
    updateReady();
  });
  mqttClient.on('error', (error) => {
    mqttReady = false;
    updateReady();
    console.error('MQTT connection error', error);
  });
  mqttClient.on('message', async (_topic, payload) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload.toString()) as Record<string, unknown>;
    } catch {
      received.inc({ outcome: 'invalid_json' });
      return;
    }
    if (!validate(event)) {
      received.inc({ outcome: 'schema_rejected' });
      return;
    }

    const end = publishDuration.startTimer();
    try {
      if (!registeredSchema) throw new Error('Internal event Schema is not registered');
      await producer.send({
        topic: kafkaTopic,
        acks: -1,
        messages: [{
          key: String(event.deviceId),
          value: JSON.stringify({
            eventType: 'device.telemetry.received',
            receivedAt: new Date().toISOString(),
            traceId: event.eventId,
            ...event,
          }),
          headers: {
            contractVersion: String(event.schemaVersion),
            schemaId: String(registeredSchema.id),
            schemaSubject: registeredSchema.subject,
            schemaVersion: String(registeredSchema.version),
            tenantId: String(event.tenantId),
            traceId: String(event.eventId),
          },
        }],
      });
      received.inc({ outcome: 'published' });
    } catch (error) {
      received.inc({ outcome: 'publish_failed' });
      console.error('Kafka telemetry publication failed', {
        eventId: String(event.eventId),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      end();
    }
  });
}

createServer(async (request, response) => {
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': registry.contentType });
    response.end(await registry.metrics());
    return;
  }
  if (request.url === '/health/ready') {
    response.writeHead(kafkaReady && mqttReady && schemaRegistryReady ? 200 : 503, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({
      kafka: kafkaReady,
      mqtt: mqttReady,
      schemaRegistry: schemaRegistryReady,
    }));
    return;
  }
  response.writeHead(404).end();
}).listen(metricsPort);

function updateReady() {
  ready.set(kafkaReady && mqttReady && schemaRegistryReady ? 1 : 0);
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
