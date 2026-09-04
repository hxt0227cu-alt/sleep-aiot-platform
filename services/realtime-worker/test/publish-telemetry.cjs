const { randomUUID } = require('node:crypto');
const { Kafka, logLevel, Partitioners } = require('kafkajs');

const brokers = required('KAFKA_BROKERS').split(',');
const topic = required('KAFKA_TELEMETRY_TOPIC');
const schemaSubject = required('SCHEMA_SUBJECT');
const schemaId = required('SCHEMA_ID');
const schemaVersion = required('SCHEMA_VERSION');
const eventId = process.env.EVENT_ID || randomUUID();
const tenantId = process.env.TENANT_ID || 'tenant-registry-outage';
const deviceId = process.env.DEVICE_ID || 'device-registry-outage';
const timestamp = new Date().toISOString();
const event = {
  eventType: 'device.telemetry.received',
  eventId,
  traceId: eventId,
  schemaVersion: 1,
  tenantId,
  deviceId,
  occurredAt: timestamp,
  receivedAt: timestamp,
  sequence: Number(process.env.SEQUENCE || 1),
  heartRate: 62,
  breathingRate: 14,
  bodyMovement: 0.2,
  sleepState: 'deep',
  confidence: 0.94,
  ...(process.env.FIRMWARE_VERSION ? { firmwareVersion: process.env.FIRMWARE_VERSION } : {}),
};

const kafka = new Kafka({ clientId: `registry-outage-publisher-${eventId}`, brokers, logLevel: logLevel.NOTHING });
const producer = kafka.producer({
  allowAutoTopicCreation: false,
  createPartitioner: Partitioners.DefaultPartitioner,
});

async function main() {
  try {
    await producer.connect();
    const metadata = await producer.send({
      topic,
      acks: -1,
      messages: [{
        key: deviceId,
        value: JSON.stringify(event),
        headers: {
          tenantId,
          traceId: eventId,
          contractVersion: '1',
          schemaId,
          schemaSubject,
          schemaVersion,
        },
      }],
    });
    console.log(JSON.stringify({
      eventId,
      tenantId,
      deviceId,
      topic,
      schema: { subject: schemaSubject, id: Number(schemaId), version: Number(schemaVersion) },
      partition: metadata[0].partition,
      offset: metadata[0].baseOffset,
    }));
  } finally {
    await producer.disconnect();
  }
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
