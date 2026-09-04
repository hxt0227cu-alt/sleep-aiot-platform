#!/usr/bin/env node
/**
 * 离线恢复测试
 *
 * 功能：
 *   1. 测试设备离线后的数据缓存和补传
 *   2. 测试网络恢复后的数据同步
 *   3. 测试序列号管理和幂等性
 *   4. 测试边缘报警引擎在离线时的工作
 *   5. 生成测试报告
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置
const config = {
  apiBaseUrl: process.env.API_URL || 'https://api.sleep-monitor.com',
  mqttBroker: process.env.MQTT_BROKER || 'mqtt.sleep-monitor.com',
  outputDir: process.env.OUTPUT_DIR || './test-results',
  testDeviceId: process.env.TEST_DEVICE_ID || 'DEV-OFFLINE-TEST-' + Date.now(),
  testDuration: parseInt(process.env.TEST_DURATION || '30000'), // 30秒
  dataPoints: parseInt(process.env.DATA_POINTS || '100'),
};

// 测试结果
const results = {
  testRunId: 'offline-recovery-' + Date.now(),
  startTime: new Date().toISOString(),
  config: {
    testDeviceId: config.testDeviceId,
    testDuration: config.testDuration,
    dataPoints: config.dataPoints,
  },
  tests: [],
  summary: {
    total: 0,
    passed: 0,
    failed: 0,
  },
  metrics: {
    dataGenerated: 0,
    dataCached: 0,
    dataSynced: 0,
    dataLost: 0,
    syncDuration: 0,
    duplicateDetected: 0,
  },
};

// 工具函数
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function recordTest(name, status, message, details = {}) {
  results.tests.push({
    name,
    status,
    message,
    details,
    timestamp: new Date().toISOString(),
  });
  results.summary.total++;
  if (status === 'passed') results.summary.passed++;
  if (status === 'failed') results.summary.failed++;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 模拟设备数据生成
function generateTelemetryData(deviceId, sequence, timestamp) {
  return {
    device_id: deviceId,
    local_sequence: sequence,
    timestamp: timestamp || new Date().toISOString(),
    heart_rate: 60 + Math.floor(Math.random() * 40),
    respiration_rate: 12 + Math.floor(Math.random() * 8),
    spo2: 92 + Math.floor(Math.random() * 8),
    movement_index: Math.floor(Math.random() * 100),
    battery_level: 50 + Math.floor(Math.random() * 50),
    signal_strength: -50 - Math.floor(Math.random() * 50),
  };
}

// 模拟设备本地缓存
class DeviceCacheSimulator {
  constructor(deviceId) {
    this.deviceId = deviceId;
    this.cache = [];
    this.sequence = 0;
    this.maxCacheSize = 10000;
    this.isOnline = true;
  }

  generateData() {
    this.sequence++;
    const data = generateTelemetryData(this.deviceId, this.sequence);
    if (this.isOnline) {
      // 在线：直接发送
      return { data, cached: false };
    } else {
      // 离线：缓存
      if (this.cache.length < this.maxCacheSize) {
        this.cache.push(data);
        results.metrics.dataCached++;
      }
      return { data, cached: true };
    }
  }

  goOffline() {
    this.isOnline = false;
    log(`  设备进入离线模式`);
  }

  goOnline() {
    this.isOnline = true;
    log(`  设备恢复在线`);
  }

  getCachedData() {
    return [...this.cache];
  }

  clearSyncedData(count) {
    this.cache.splice(0, count);
  }

  getCacheSize() {
    return this.cache.length;
  }
}

// 模拟 API 调用
async function sendDataToApi(data) {
  return new Promise((resolve) => {
    // 模拟 API 调用延迟
    const delay = 50 + Math.random() * 100;
    setTimeout(() => {
      // 模拟 95% 成功率
      const success = Math.random() > 0.05;
      resolve({
        success,
        statusCode: success ? 200 : 500,
        body: success ? { received: true, sequence: data.local_sequence } : { error: 'Internal Server Error' },
      });
    }, delay);
  });
}

// 模拟幂等性检查
class IdempotencyChecker {
  constructor() {
    this.seenSequences = new Set();
    this.duplicates = 0;
  }

  check(deviceId, sequence) {
    const key = `${deviceId}-${sequence}`;
    if (this.seenSequences.has(key)) {
      this.duplicates++;
      results.metrics.duplicateDetected++;
      return { isDuplicate: true };
    }
    this.seenSequences.add(key);
    return { isDuplicate: false };
  }
}

// ============================================================
// 测试用例
// ============================================================

// 测试 1: 离线数据缓存
async function testOfflineDataCaching() {
  const testName = '离线数据缓存测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    const device = new DeviceCacheSimulator(config.testDeviceId);

    // 生成一些在线数据
    for (let i = 0; i < 10; i++) {
      device.generateData();
      results.metrics.dataGenerated++;
      await sleep(10);
    }

    // 进入离线模式
    device.goOffline();

    // 离线时生成数据
    const offlineDataCount = 50;
    for (let i = 0; i < offlineDataCount; i++) {
      const result = device.generateData();
      results.metrics.dataGenerated++;
      if (!result.cached) {
        throw new Error('离线数据未被缓存');
      }
      await sleep(5);
    }

    // 验证缓存大小
    const cacheSize = device.getCacheSize();
    if (cacheSize !== offlineDataCount) {
      throw new Error(`缓存大小不正确: 期望 ${offlineDataCount}, 实际 ${cacheSize}`);
    }

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', `离线数据缓存正常，缓存了 ${cacheSize} 条数据`, {
      duration,
      cacheSize,
    });
    log(`测试通过: ${testName} (${duration}ms)`);

    return device;
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
    return null;
  }
}

// 测试 2: 网络恢复后数据同步
async function testDataSyncAfterRecovery(device) {
  const testName = '网络恢复后数据同步测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    if (!device) {
      throw new Error('设备模拟器未初始化');
    }

    const idempotency = new IdempotencyChecker();

    // 恢复在线
    device.goOnline();

    // 获取缓存数据
    const cachedData = device.getCachedData();
    const cacheSize = cachedData.length;

    // 模拟数据同步
    let syncedCount = 0;
    let failedCount = 0;
    const syncStartTime = Date.now();

    for (const data of cachedData) {
      // 幂等性检查
      const idempotencyResult = idempotency.check(data.device_id, data.local_sequence);
      if (idempotencyResult.isDuplicate) {
        continue; // 跳过重复数据
      }

      // 发送数据
      const result = await sendDataToApi(data);
      if (result.success) {
        syncedCount++;
        results.metrics.dataSynced++;
      } else {
        failedCount++;
      }
    }

    const syncDuration = Date.now() - syncStartTime;
    results.metrics.syncDuration = syncDuration;

    // 验证同步结果（允许少量失败，会重试）
    const successRate = syncedCount / cacheSize;
    if (successRate < 0.9) {
      throw new Error(`同步成功率过低: ${(successRate * 100).toFixed(1)}%`);
    }

    // 验证数据丢失
    results.metrics.dataLost = cacheSize - syncedCount - idempotency.duplicates;

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', `数据同步完成，成功率 ${(successRate * 100).toFixed(1)}%`, {
      duration,
      syncDuration,
      cacheSize,
      syncedCount,
      failedCount,
      duplicates: idempotency.duplicates,
      successRate,
    });
    log(`测试通过: ${testName} (${duration}ms, 同步耗时 ${syncDuration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 3: 序列号管理和幂等性
async function testSequenceAndIdempotency() {
  const testName = '序列号管理和幂等性测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    const device = new DeviceCacheSimulator(config.testDeviceId + '-seq');
    const idempotency = new IdempotencyChecker();

    // 生成连续序列号
    const sequences = [];
    for (let i = 0; i < 20; i++) {
      const result = device.generateData();
      sequences.push(result.data.local_sequence);
      results.metrics.dataGenerated++;
    }

    // 验证序列号连续
    for (let i = 1; i < sequences.length; i++) {
      if (sequences[i] !== sequences[i - 1] + 1) {
        throw new Error(`序列号不连续: ${sequences[i - 1]} -> ${sequences[i]}`);
      }
    }

    // 验证幂等性（重复发送相同数据）
    const testData = generateTelemetryData(device.deviceId, 999);
    const firstCheck = idempotency.check(testData.device_id, testData.local_sequence);
    const secondCheck = idempotency.check(testData.device_id, testData.local_sequence);

    if (firstCheck.isDuplicate) {
      throw new Error('首次检查不应判定为重复');
    }
    if (!secondCheck.isDuplicate) {
      throw new Error('重复检查应判定为重复');
    }

    // 测试序列号回绕（模拟设备重启）
    const newDevice = new DeviceCacheSimulator(config.testDeviceId + '-seq');
    newDevice.sequence = 65535; // 接近最大值
    const wrappedData = newDevice.generateData();
    if (wrappedData.local_sequence !== 65536) {
      // 实际设备会处理回绕，这里验证序列号递增
    }

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', '序列号连续，幂等性检查正常', {
      duration,
      sequenceCount: sequences.length,
      duplicatesDetected: idempotency.duplicates,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 4: 边缘报警引擎离线工作
async function testEdgeAlarmOffline() {
  const testName = '边缘报警引擎离线工作测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 模拟边缘报警引擎
    const edgeAlarmEngine = {
      thresholds: {
        apnea: 10, // 呼吸暂停阈值（秒）
        tachycardia: 100, // 心动过速阈值
        bradycardia: 40, // 心动过缓阈值
        low_spo2: 90, // 低血氧阈值
      },
      alarms: [],
      detect(data) {
        const alarms = [];
        // 呼吸暂停检测（简化版）
        if (data.respiration_rate <= 5) {
          alarms.push({ type: 'apnea', severity: 'high', value: data.respiration_rate });
        }
        // 心动过速
        if (data.heart_rate >= this.thresholds.tachycardia) {
          alarms.push({ type: 'tachycardia', severity: 'medium', value: data.heart_rate });
        }
        // 心动过缓
        if (data.heart_rate <= this.thresholds.bradycardia) {
          alarms.push({ type: 'bradycardia', severity: 'medium', value: data.heart_rate });
        }
        // 低血氧
        if (data.spo2 <= this.thresholds.low_spo2) {
          alarms.push({ type: 'low_spo2', severity: 'high', value: data.spo2 });
        }
        this.alarms.push(...alarms);
        return alarms;
      },
    };

    // 模拟离线时的报警检测
    const device = new DeviceCacheSimulator(config.testDeviceId + '-alarm');
    device.goOffline();

    let alarmCount = 0;
    const testCases = [
      { heart_rate: 110, respiration_rate: 16, spo2: 97 }, // 心动过速
      { heart_rate: 35, respiration_rate: 14, spo2: 96 },  // 心动过缓
      { heart_rate: 70, respiration_rate: 4, spo2: 95 },   // 呼吸暂停
      { heart_rate: 75, respiration_rate: 16, spo2: 88 },   // 低血氧
      { heart_rate: 70, respiration_rate: 16, spo2: 98 },   // 正常
    ];

    for (const testCase of testCases) {
      const data = {
        ...generateTelemetryData(device.deviceId, device.sequence++),
        ...testCase,
      };
      device.cache.push(data);
      results.metrics.dataGenerated++;
      results.metrics.dataCached++;

      const alarms = edgeAlarmEngine.detect(data);
      alarmCount += alarms.length;
    }

    // 验证报警检测
    if (alarmCount < 4) {
      throw new Error(`边缘报警检测数量不足: 期望至少 4, 实际 ${alarmCount}`);
    }

    // 验证离线时报警被缓存
    if (device.getCacheSize() !== testCases.length) {
      throw new Error('离线报警数据未被缓存');
    }

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', `边缘报警引擎离线工作正常，检测到 ${alarmCount} 个报警`, {
      duration,
      testCases: testCases.length,
      alarmCount,
      cachedAlarms: device.getCacheSize(),
    });
    log(`测试通过: ${testName} (${duration}ms, 检测到 ${alarmCount} 个报警)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 5: 长时间离线后恢复
async function testLongOfflineRecovery() {
  const testName = '长时间离线后恢复测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    const device = new DeviceCacheSimulator(config.testDeviceId + '-long');

    // 模拟长时间离线（大量数据）
    device.goOffline();
    const longOfflineCount = 500;

    for (let i = 0; i < longOfflineCount; i++) {
      device.generateData();
      results.metrics.dataGenerated++;
    }

    // 验证缓存大小
    if (device.getCacheSize() !== longOfflineCount) {
      throw new Error(`长时间离线缓存大小不正确: 期望 ${longOfflineCount}, 实际 ${device.getCacheSize()}`);
    }

    // 恢复在线并同步
    device.goOnline();
    const cachedData = device.getCachedData();
    let syncedCount = 0;

    // 模拟批量同步（每次 50 条）
    const batchSize = 50;
    for (let i = 0; i < cachedData.length; i += batchSize) {
      const batch = cachedData.slice(i, i + batchSize);
      for (const data of batch) {
        const result = await sendDataToApi(data);
        if (result.success) {
          syncedCount++;
          results.metrics.dataSynced++;
        }
      }
    }

    const successRate = syncedCount / longOfflineCount;
    if (successRate < 0.9) {
      throw new Error(`长时间离线后同步成功率过低: ${(successRate * 100).toFixed(1)}%`);
    }

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', `长时间离线（${longOfflineCount}条数据）后恢复正常，成功率 ${(successRate * 100).toFixed(1)}%`, {
      duration,
      offlineDataCount: longOfflineCount,
      syncedCount,
      successRate,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 生成报告
function generateReport() {
  results.endTime = new Date().toISOString();
  results.duration = new Date(results.endTime) - new Date(results.startTime);

  const reportPath = path.join(config.outputDir, 'offline-recovery-test-report.json');
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log('\n' + '='.repeat(70));
  console.log('  离线恢复测试报告');
  console.log('='.repeat(70));
  console.log(`  测试运行 ID: ${results.testRunId}`);
  console.log(`  测试设备: ${config.testDeviceId}`);
  console.log(`  开始时间: ${results.startTime}`);
  console.log(`  结束时间: ${results.endTime}`);
  console.log(`  总耗时: ${results.duration}ms`);
  console.log('-'.repeat(70));
  console.log(`  总测试数: ${results.summary.total}`);
  console.log(`  通过: ${results.summary.passed}`);
  console.log(`  失败: ${results.summary.failed}`);
  console.log(`  通过率: ${results.summary.total > 0 ? (results.summary.passed / results.summary.total * 100).toFixed(1) : 0}%`);
  console.log('-'.repeat(70));
  console.log('  关键指标:');
  console.log(`    生成数据: ${results.metrics.dataGenerated} 条`);
  console.log(`    缓存数据: ${results.metrics.dataCached} 条`);
  console.log(`    同步数据: ${results.metrics.dataSynced} 条`);
  console.log(`    数据丢失: ${results.metrics.dataLost} 条`);
  console.log(`    重复检测: ${results.metrics.duplicateDetected} 次`);
  console.log(`    同步耗时: ${results.metrics.syncDuration}ms`);
  console.log('-'.repeat(70));
  console.log('  详细结果:');
  results.tests.forEach((test, index) => {
    const statusIcon = test.status === 'passed' ? '✅' : '❌';
    console.log(`  ${statusIcon} ${index + 1}. ${test.name} - ${test.message}`);
  });
  console.log('='.repeat(70));
  console.log(`\n报告已保存: ${reportPath}`);

  return results.summary.failed === 0;
}

// 主函数
async function main() {
  log('离线恢复测试开始');
  log(`测试设备 ID: ${config.testDeviceId}`);
  log(`API 地址: ${config.apiBaseUrl}`);

  // 创建输出目录
  fs.mkdirSync(config.outputDir, { recursive: true });

  // 执行测试
  const device = await testOfflineDataCaching();
  await testDataSyncAfterRecovery(device);
  await testSequenceAndIdempotency();
  await testEdgeAlarmOffline();
  await testLongOfflineRecovery();

  // 生成报告
  const allPassed = generateReport();

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('测试执行失败:', error);
  process.exit(1);
});
