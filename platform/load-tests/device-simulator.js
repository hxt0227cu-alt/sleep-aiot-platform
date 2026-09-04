/* Deterministic simulated device workload. No physical hardware is required.
 * Usage: node device-simulator.js --devices 10 --rate 2 --duration 60 --seed 20260724
 * Faults: --offline-every 5 --timeout-every 7 --duplicate-every 11
 */
import mqtt from 'mqtt';
import { fileURLToPath } from 'url';

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].startsWith('--')) result[values[index].slice(2)] = values[index + 1];
  }
  return result;
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function createTelemetry({ tenantId, deviceId, sequence, seed, occurredAt }) {
  const random = seededRandom(seed + sequence + Number(deviceId.replace(/\D/g, '')));
  return {
    eventId: `${deviceId}-${String(sequence).padStart(10, '0')}`,
    schemaVersion: 1,
    evidence: 'simulated',
    tenantId,
    deviceId,
    occurredAt,
    heartRate: 52 + Math.floor(random() * 34),
    breathingRate: 11 + Math.floor(random() * 8),
    bodyMovement: Number(random().toFixed(3)),
    sleepState: ['awake', 'light', 'deep', 'rem'][Math.floor(random() * 4)],
    sequence,
  };
}

export function commandResponse(deviceId, command, sequence, options) {
  if (options.timeoutEvery > 0 && sequence % options.timeoutEvery === 0) return null;
  return {
    commandId: command.commandId || command.command_id || `unknown-${sequence}`,
    deviceId,
    status: command.action === 'reject' ? 'rejected' : 'acknowledged',
    evidence: 'simulated',
    sequence,
    timestamp: new Date().toISOString(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    devices: Number(args.devices || 10), rate: Number(args.rate || 1), duration: Number(args.duration || 60),
    seed: Number(args.seed || 20260724), offlineEvery: Number(args['offline-every'] || 0),
    timeoutEvery: Number(args['timeout-every'] || 0), duplicateEvery: Number(args['duplicate-every'] || 0),
  };
  const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';
  const tenantId = process.env.SIM_TENANT_ID || 'tenant-simulated';
  const client = mqtt.connect(brokerUrl, { clientId: `simulator-${options.seed}`, clean: true, reconnectPeriod: 1000 });
  let sent = 0; let duplicated = 0; let acknowledgements = 0; let timedOutCommands = 0; let startedAt;
  const timers = [];

  client.on('connect', () => {
    startedAt = Date.now();
    client.subscribe('device/+/command', { qos: 1 });
    for (let index = 0; index < options.devices; index += 1) {
      const deviceId = `sim-${String(index + 1).padStart(6, '0')}`;
      if (options.offlineEvery > 0 && (index + 1) % options.offlineEvery === 0) continue;
      const timer = setInterval(() => {
        const payload = createTelemetry({ tenantId, deviceId, sequence: sent, seed: options.seed, occurredAt: new Date().toISOString() });
        const topic = `device/${deviceId}/telemetry`;
        client.publish(topic, JSON.stringify(payload), { qos: 1 });
        sent += 1;
        if (options.duplicateEvery > 0 && sent % options.duplicateEvery === 0) {
          client.publish(topic, JSON.stringify(payload), { qos: 1 });
          duplicated += 1;
        }
      }, Math.max(1, Math.floor(1000 / options.rate)));
      timers.push(timer);
    }
    setTimeout(() => {
      timers.forEach(clearInterval);
      client.end(false, {}, () => {
        const seconds = Math.max(1, (Date.now() - startedAt) / 1000);
        console.log(JSON.stringify({ evidence: 'simulated', seed: options.seed, ...options, sent, duplicated, acknowledgements, timedOutCommands, observedEventsPerSecond: sent / seconds }));
      });
    }, options.duration * 1000);
  });

  client.on('message', (topic, buffer) => {
    const deviceId = topic.split('/')[1];
    let command;
    try { command = JSON.parse(buffer.toString()); } catch { return; }
    const response = commandResponse(deviceId, command, acknowledgements + timedOutCommands + 1, options);
    if (!response) { timedOutCommands += 1; return; }
    client.publish(`device/${deviceId}/command/response`, JSON.stringify(response), { qos: 1 });
    acknowledgements += 1;
  });

  client.on('error', (error) => {
    console.error(JSON.stringify({ evidence: 'simulated', error: error.message }));
    process.exitCode = 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
export { parseArgs, seededRandom };
