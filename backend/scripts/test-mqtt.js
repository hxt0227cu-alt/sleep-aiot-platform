const mqtt = require('mqtt');
require('dotenv').config();

const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const username = process.env.MQTT_USERNAME || 'hxt';
const password = process.env.MQTT_PASSWORD;

if (!password) {
  throw new Error('MQTT_PASSWORD is required');
}

console.log('MQTT Test Tool');
console.log('=' .repeat(50));
console.log(`Broker: ${brokerUrl}`);
console.log(`Username: ${username}`);
console.log();

const client = mqtt.connect(brokerUrl, {
  username,
  password,
  clientId: `test-client-${Date.now()}`,
  clean: true,
  reconnectPeriod: 5000,
  keepalive: 30,
});

client.on('connect', () => {
  console.log('✓ Connected to MQTT broker');
  console.log();

  const topics = [
    'device/test/telemetry',
    'device/test/status',
    'device/test/alarm',
    'device/test/log',
    'device/test/command/response',
  ];

  console.log('Subscribing to topics:');
  topics.forEach(topic => {
    client.subscribe(topic, (err) => {
      if (!err) {
        console.log(`  - ${topic}`);
      } else {
        console.error(`  x Failed to subscribe to ${topic}:`, err.message);
      }
    });
  });

  console.log();
  console.log('Sending test messages...');
  console.log();

  setTimeout(() => {
    sendTelemetry();
  }, 500);

  setTimeout(() => {
    sendStatus();
  }, 1000);

  setTimeout(() => {
    sendAlarm();
  }, 1500);

  setTimeout(() => {
    sendCommand();
  }, 2000);

  setTimeout(() => {
    console.log();
    console.log('Test completed! Press Ctrl+C to exit.');
    console.log('Listening for messages...');
  }, 2500);
});

client.on('error', (error) => {
  console.error('✗ MQTT connection error:', error.message);
});

client.on('message', (topic, message) => {
  console.log();
  console.log(`📨 Received message on: ${topic}`);
  try {
    const data = JSON.parse(message.toString());
    console.log('   Data:', JSON.stringify(data, null, 2));
  } catch {
    console.log('   Message:', message.toString());
  }
});

function sendTelemetry() {
  const data = {
    ts: Date.now(),
    type: 'vital_signs',
    data: {
      heart_rate: {
        value: 72,
        unit: 'bpm',
        status: 'normal',
      },
      breathing_rate: {
        value: 16,
        unit: 'times/min',
        status: 'normal',
      },
      body_movement: {
        value: 0.2,
        unit: 'g',
        status: 'low',
      },
      sleep_state: {
        state: 'light_sleep',
        confidence: 0.92,
      },
    },
  };

  publish('device/test/telemetry', data, 'Telemetry');
}

function sendStatus() {
  const data = {
    ts: Date.now(),
    online: true,
    wifi: {
      ssid: 'Home_WiFi',
      signal_strength: -45,
      ip_address: '192.168.1.100',
    },
    system: {
      uptime: 86400,
      memory_usage: 65,
      cpu_usage: 30,
      free_heap: 245760,
    },
    firmware: {
      version: '1.0.0',
      build_date: '2024-01-01',
    },
  };

  publish('device/test/status', data, 'Status');
}

function sendAlarm() {
  const data = {
    ts: Date.now(),
    alarm_id: 'alarm_001',
    type: 'heart_rate_high',
    level: 'critical',
    message: '心率异常偏高',
    value: 125,
    threshold: 120,
    duration: 60,
  };

  publish('device/test/alarm', data, 'Alarm');
}

function sendCommand() {
  const data = {
    cmd_id: 'cmd_001',
    command: 'light_control',
    params: {
      power: true,
      brightness: 80,
      color_temp: 4000,
    },
    timeout: 5000,
  };

  publish('device/test/command', data, 'Command');
}

function publish(topic, data, type) {
  client.publish(topic, JSON.stringify(data), { qos: 1 }, (err) => {
    if (err) {
      console.error(`✗ Failed to send ${type}:`, err.message);
    } else {
      console.log(`✓ Sent ${type} to ${topic}`);
    }
  });
}

process.on('SIGINT', () => {
  console.log();
  console.log('Disconnecting...');
  client.end();
  process.exit();
});
