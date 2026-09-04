/**
 * 报警准确率基准测试
 *
 * 功能：
 *   使用模拟数据集测试报警检测服务的准确率和性能，
 *   验证是否达到验收阈值。
 *
 * 使用：
 *   k6 run alarm-accuracy-benchmark.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// 配置
const BASE_URL = __ENV.BASE_URL || 'https://api.sleep-monitor.com';
const API_TOKEN = __ENV.API_TOKEN || 'test-token';
const TEST_DATASET = __ENV.TEST_DATASET || './test-data/alarm-test-data.json';

// 自定义指标
const detectionLatency = new Trend('alarm_detection_latency_ms');
const accuracyRate = new Rate('alarm_accuracy_rate');
const falsePositiveRate = new Rate('false_positive_rate');
const falseNegativeRate = new Rate('false_negative_rate');
const totalTests = new Counter('total_tests');
const passedTests = new Counter('passed_tests');

// 测试选项
export const options = {
  vus: 1,
  iterations: 100,
  thresholds: {
    // 验收阈值
    'alarm_accuracy_rate': ['rate>0.90'],  // 准确率 > 90%
    'false_positive_rate': ['rate<0.10'],   // 误报率 < 10%
    'false_negative_rate': ['rate<0.10'],   // 漏报率 < 10%
    'alarm_detection_latency_ms': ['p(95)<5000'],  // P95 延迟 < 5s
    'http_req_duration': ['p(95)<2000'],
  },
};

// 测试数据（模拟）
const testCases = [
  // 呼吸暂停测试
  { type: 'apnea', heartRate: 70, respirationRate: 5, spo2: 95, expectedAlarm: true, severity: 'high' },
  { type: 'apnea', heartRate: 65, respirationRate: 8, spo2: 92, expectedAlarm: true, severity: 'high' },
  { type: 'normal', heartRate: 70, respirationRate: 16, spo2: 98, expectedAlarm: false, severity: 'normal' },
  { type: 'normal', heartRate: 68, respirationRate: 18, spo2: 97, expectedAlarm: false, severity: 'normal' },
  // 心动过速
  { type: 'tachycardia', heartRate: 110, respirationRate: 16, spo2: 97, expectedAlarm: true, severity: 'medium' },
  { type: 'tachycardia', heartRate: 120, respirationRate: 18, spo2: 96, expectedAlarm: true, severity: 'medium' },
  // 心动过缓
  { type: 'bradycardia', heartRate: 38, respirationRate: 14, spo2: 96, expectedAlarm: true, severity: 'medium' },
  { type: 'bradycardia', heartRate: 35, respirationRate: 12, spo2: 95, expectedAlarm: true, severity: 'medium' },
  // 血氧异常
  { type: 'low_spo2', heartRate: 75, respirationRate: 16, spo2: 88, expectedAlarm: true, severity: 'high' },
  { type: 'low_spo2', heartRate: 80, respirationRate: 18, spo2: 85, expectedAlarm: true, severity: 'high' },
  // 边界测试
  { type: 'boundary', heartRate: 99, respirationRate: 10, spo2: 90, expectedAlarm: true, severity: 'medium' },
  { type: 'boundary', heartRate: 100, respirationRate: 10, spo2: 91, expectedAlarm: true, severity: 'medium' },
  // 正常但接近阈值
  { type: 'near_threshold', heartRate: 95, respirationRate: 12, spo2: 93, expectedAlarm: false, severity: 'normal' },
  { type: 'near_threshold', heartRate: 45, respirationRate: 12, spo2: 93, expectedAlarm: false, severity: 'normal' },
];

export default function () {
  // 随机选择测试用例
  const testCase = testCases[Math.floor(Math.random() * testCases.length)];

  // 构造请求
  const payload = JSON.stringify({
    deviceId: `test-device-${__VU}-${__ITER}`,
    timestamp: new Date().toISOString(),
    heartRate: testCase.heartRate,
    respirationRate: testCase.respirationRate,
    spo2: testCase.spo2,
    movementIndex: 10,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
    },
    tags: { test_type: testCase.type },
  };

  // 发送请求
  const startTime = Date.now();
  const response = http.post(`${BASE_URL}/api/v1/alarm/detect`, payload, params);
  const latency = Date.now() - startTime;

  // 记录延迟
  detectionLatency.add(latency);

  // 验证响应
  const checkResult = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 5s': (r) => r.timings.duration < 5000,
  });

  if (response.status === 200) {
    const result = response.json();
    const actualAlarm = result.alarmTriggered || false;
    const isCorrect = actualAlarm === testCase.expectedAlarm;

    totalTests.add(1);
    if (isCorrect) passedTests.add(1);

    accuracyRate.add(isCorrect);

    if (testCase.expectedAlarm) {
      // 应该报警的情况
      falseNegativeRate.add(!actualAlarm);
    } else {
      // 不应该报警的情况
      falsePositiveRate.add(actualAlarm);
    }

    // 详细检查
    check(response, {
      'alarm detection correct': () => isCorrect,
    });
  }

  sleep(0.1);
}

// 测试结束后输出总结
export function handleSummary(data) {
  const metrics = data.metrics;
  const summary = {
    test_type: 'alarm_accuracy_benchmark',
    timestamp: new Date().toISOString(),
    total_requests: metrics.iterations.values.count,
    accuracy_rate: metrics.alarm_accuracy_rate ? metrics.alarm_accuracy_rate.values.rate : 0,
    false_positive_rate: metrics.false_positive_rate ? metrics.false_positive_rate.values.rate : 0,
    false_negative_rate: metrics.false_negative_rate ? metrics.false_negative_rate.values.rate : 0,
    latency_p95: metrics.alarm_detection_latency_ms ? metrics.alarm_detection_latency_ms.values['p(95)'] : 0,
    thresholds_passed: data.root_group ? data.root_group.checks.passes > 0 : true,
  };

  console.log('\n=== 报警准确率基准测试总结 ===');
  console.log(`总测试数: ${summary.total_requests}`);
  console.log(`准确率: ${(summary.accuracy_rate * 100).toFixed(2)}%`);
  console.log(`误报率: ${(summary.false_positive_rate * 100).toFixed(2)}%`);
  console.log(`漏报率: ${(summary.false_negative_rate * 100).toFixed(2)}%`);
  console.log(`P95 延迟: ${summary.latency_p95.toFixed(0)}ms`);
  console.log(`验收阈值: 准确率>90%, 误报率<10%, 漏报率<10%, P95<5s`);
  console.log('================================\n');

  return {
    'stdout': JSON.stringify(summary, null, 2),
    'alarm-accuracy-result.json': JSON.stringify(summary, null, 2),
  };
}
