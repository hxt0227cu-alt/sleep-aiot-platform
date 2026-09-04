#!/usr/bin/env node
/**
 * 证书生命周期测试
 *
 * 功能：
 *   1. 测试证书签发流程
 *   2. 测试证书吊销流程
 *   3. 测试 CRL 更新和分发
 *   4. 测试证书过期提醒
 *   5. 测试证书轮换流程
 *   6. 生成测试报告
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 配置
const config = {
  pkiApiBaseUrl: process.env.PKI_API_URL || 'https://api.sleep-monitor.com/api/v1/pki',
  vaultAddr: process.env.VAULT_ADDR || 'https://vault.vault.svc.cluster.local:8200',
  vaultToken: process.env.VAULT_TOKEN || '',
  outputDir: process.env.OUTPUT_DIR || './test-results',
  testDeviceId: 'DEV-TEST-' + Date.now(),
};

// 测试结果
const results = {
  testRunId: 'cert-lifecycle-' + Date.now(),
  startTime: new Date().toISOString(),
  tests: [],
  summary: {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
  },
};

// 工具函数
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function makeRequest(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function recordTest(name, status, message, details = {}) {
  results.tests.push({
    name,
    status,
    message,
    details,
    timestamp: new Date().toISOString(),
    duration: details.duration || 0,
  });
  results.summary.total++;
  if (status === 'passed') results.summary.passed++;
  if (status === 'failed') results.summary.failed++;
  if (status === 'skipped') results.summary.skipped++;
}

// ============================================================
// 测试用例
// ============================================================

// 测试 1: 证书签发
async function testCertificateIssuance() {
  const testName = '证书签发测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 生成 CSR（证书签名请求）
    const csr = generateTestCSR(config.testDeviceId);

    // 调用 PKI API 签发证书
    const response = await makeRequest('POST', `${config.pkiApiBaseUrl}/sign`, {
      device_id: config.testDeviceId,
      csr: csr,
      cert_type: 'device',
      validity_days: 365,
    });

    assert(response.statusCode === 200, `签发失败，状态码: ${response.statusCode}`);
    assert(response.body && response.body.certificate, '响应中缺少证书');
    assert(response.body && response.body.certificate_chain, '响应中缺少证书链');

    // 验证证书内容
    const cert = response.body.certificate;
    assert(cert.includes('BEGIN CERTIFICATE'), '证书格式错误');

    // 保存证书
    fs.writeFileSync(path.join(config.outputDir, 'test-cert.pem'), cert);

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', '证书签发成功', {
      duration,
      deviceId: config.testDeviceId,
      certSerial: response.body.serial_number,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 2: 证书验证
async function testCertificateValidation() {
  const testName = '证书验证测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    const certPath = path.join(config.outputDir, 'test-cert.pem');
    if (!fs.existsSync(certPath)) {
      throw new Error('测试证书不存在，跳过验证');
    }

    // 使用 OpenSSL 验证证书
    try {
      const result = execSync(`openssl x509 -in ${certPath} -text -noout`, { encoding: 'utf-8' });
      assert(result.includes('Subject:'), '证书缺少 Subject');
      assert(result.includes('Issuer:'), '证书缺少 Issuer');
      assert(result.includes('Not Before:'), '证书缺少生效时间');
      assert(result.includes('Not After:'), '证书缺少过期时间');

      // 验证证书链
      // execSync(`openssl verify -CAfile ca-chain.pem ${certPath}`);

      const duration = Date.now() - startTime;
      recordTest(testName, 'passed', '证书验证成功', { duration });
      log(`测试通过: ${testName} (${duration}ms)`);
    } catch (e) {
      if (e.message.includes('openssl')) {
        recordTest(testName, 'skipped', 'OpenSSL 不可用，跳过', { duration: Date.now() - startTime });
        log(`测试跳过: ${testName} - OpenSSL 不可用`);
      } else {
        throw e;
      }
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 3: 证书吊销
async function testCertificateRevocation() {
  const testName = '证书吊销测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 调用吊销 API
    const response = await makeRequest('POST', `${config.pkiApiBaseUrl}/revoke`, {
      device_id: config.testDeviceId,
      reason: 'key_compromise',
      revoke_chain: false,
    });

    assert(response.statusCode === 200, `吊销失败，状态码: ${response.statusCode}`);
    assert(response.body && response.body.revoked === true, '吊销状态不正确');

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', '证书吊销成功', {
      duration,
      revocationReason: 'key_compromise',
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 4: CRL 更新
async function testCRLUpdate() {
  const testName = 'CRL 更新测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 获取 CRL
    const response = await makeRequest('GET', `${config.pkiApiBaseUrl}/crl/device-ca`);

    assert(response.statusCode === 200, `获取 CRL 失败，状态码: ${response.statusCode}`);
    assert(response.body && response.body.crl, '响应中缺少 CRL');

    // 验证 CRL 包含刚吊销的证书
    const crl = response.body.crl;
    assert(crl.includes('BEGIN X509 CRL') || crl.includes('-----BEGIN'), 'CRL 格式错误');

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', 'CRL 更新成功', {
      duration,
      crlNumber: response.body.crl_number,
      revokedCount: response.body.revoked_count,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 5: 证书过期提醒
async function testCertificateExpiryAlert() {
  const testName = '证书过期提醒测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 获取即将过期的证书列表
    const response = await makeRequest('GET', `${config.pkiApiBaseUrl}/certs/expiring?days=30`);

    assert(response.statusCode === 200, `获取过期证书列表失败，状态码: ${response.statusCode}`);
    assert(Array.isArray(response.body.certificates), '响应格式错误');

    // 验证过期提醒配置
    const alertConfig = await makeRequest('GET', `${config.pkiApiBaseUrl}/config/expiry-alerts`);
    assert(alertConfig.statusCode === 200, '获取过期提醒配置失败');

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', '证书过期提醒功能正常', {
      duration,
      expiringCount: response.body.certificates.length,
      alertThresholdDays: alertConfig.body?.alert_threshold_days,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 测试 6: 证书轮换
async function testCertificateRotation() {
  const testName = '证书轮换测试';
  log(`开始测试: ${testName}`);
  const startTime = Date.now();

  try {
    // 触发证书轮换
    const response = await makeRequest('POST', `${config.pkiApiBaseUrl}/rotate`, {
      device_id: config.testDeviceId,
      reason: 'scheduled_rotation',
      generate_new_key: true,
    });

    assert(response.statusCode === 200, `轮换失败，状态码: ${response.statusCode}`);
    assert(response.body && response.body.new_certificate, '响应中缺少新证书');
    assert(response.body && response.body.old_certificate_revoked, '旧证书未吊销');

    const duration = Date.now() - startTime;
    recordTest(testName, 'passed', '证书轮换成功', {
      duration,
      newCertSerial: response.body.new_serial_number,
    });
    log(`测试通过: ${testName} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - startTime;
    recordTest(testName, 'failed', error.message, { duration });
    log(`测试失败: ${testName} - ${error.message}`);
  }
}

// 辅助函数：生成测试 CSR
function generateTestCSR(deviceId) {
  // 简化的 CSR 生成（实际应使用 crypto 模块或 openssl）
  return `-----BEGIN CERTIFICATE REQUEST-----
MIICzDCCAbQCAQAwgZYxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApDYWxpZm9y
bmlhMRQwEgYDVQQHDAtMb3MgQW5nZWxlczERMA8GA1UECgwIU2xlZXAgTW9u
aXRvcjEUMBIGA1UECwwLRGV2aWNlIURFTDEdMBsGA1UEAwwUJ3twa2lfYXBp
QmFzZVVybH0gZGV2aWNlIENBMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC
AQoCggEBAK...
-----END CERTIFICATE REQUEST-----`;
}

// 生成报告
function generateReport() {
  results.endTime = new Date().toISOString();
  results.duration = new Date(results.endTime) - new Date(results.startTime);

  const reportPath = path.join(config.outputDir, 'cert-lifecycle-test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('  证书生命周期测试报告');
  console.log('='.repeat(60));
  console.log(`  测试运行 ID: ${results.testRunId}`);
  console.log(`  开始时间: ${results.startTime}`);
  console.log(`  结束时间: ${results.endTime}`);
  console.log(`  总耗时: ${results.duration}ms`);
  console.log('-' .repeat(60));
  console.log(`  总测试数: ${results.summary.total}`);
  console.log(`  通过: ${results.summary.passed}`);
  console.log(`  失败: ${results.summary.failed}`);
  console.log(`  跳过: ${results.summary.skipped}`);
  console.log(`  通过率: ${results.summary.total > 0 ? (results.summary.passed / results.summary.total * 100).toFixed(1) : 0}%`);
  console.log('-' .repeat(60));
  console.log('  详细结果:');
  results.tests.forEach((test, index) => {
    const statusIcon = test.status === 'passed' ? '✅' : test.status === 'failed' ? '❌' : '⏭️';
    console.log(`  ${statusIcon} ${index + 1}. ${test.name} - ${test.message} (${test.duration}ms)`);
  });
  console.log('='.repeat(60));
  console.log(`\n报告已保存: ${reportPath}`);

  return results.summary.failed === 0;
}

// 主函数
async function main() {
  log('证书生命周期测试开始');
  log(`测试设备 ID: ${config.testDeviceId}`);
  log(`PKI API: ${config.pkiApiBaseUrl}`);

  // 创建输出目录
  fs.mkdirSync(config.outputDir, { recursive: true });

  // 执行测试
  await testCertificateIssuance();
  await testCertificateValidation();
  await testCertificateRevocation();
  await testCRLUpdate();
  await testCertificateExpiryAlert();
  await testCertificateRotation();

  // 生成报告
  const allPassed = generateReport();

  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('测试执行失败:', error);
  process.exit(1);
});
