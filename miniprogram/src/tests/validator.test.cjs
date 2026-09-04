/**
 * 表单验证器单元测试
 *
 * 功能：
 *   测试小程序中使用的各种表单验证器，包括：
 *   - 手机号验证
 *   - 邮箱验证
 *   - 密码强度验证
 *   - 身份证号验证
 *   - 设备序列号验证
 *   - 输入长度验证
 */

const assert = require('assert');

// ============================================================
// 验证器实现（与 src/utils/validator.ts 保持一致）
// ============================================================

const Validators = {
  // 手机号验证（中国大陆）
  isPhone(phone) {
    if (!phone || typeof phone !== 'string') return false;
    return /^1[3-9]\d{9}$/.test(phone.trim());
  },

  // 邮箱验证
  isEmail(email) {
    if (!email || typeof email !== 'string') return false;
    return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
  },

  // 密码强度验证
  // 要求：8-20位，包含字母和数字
  isPasswordStrong(password) {
    if (!password || typeof password !== 'string') return false;
    if (password.length < 8 || password.length > 20) return false;
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    return hasLetter && hasNumber;
  },

  // 身份证号验证（18位）
  isIDCard(idCard) {
    if (!idCard || typeof idCard !== 'string') return false;
    const trimmed = idCard.trim().toUpperCase();
    if (!/^\d{17}[\dX]$/.test(trimmed)) return false;

    // 校验码验证
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) {
      sum += parseInt(trimmed[i]) * weights[i];
    }
    const checkCode = checkCodes[sum % 11];
    return checkCode === trimmed[17];
  },

  // 设备序列号验证
  isDeviceSN(sn) {
    if (!sn || typeof sn !== 'string') return false;
    // 格式：DEV-YYYYMMDD-XXXX（4位数字）
    return /^DEV-\d{8}-\d{4}$/.test(sn.trim().toUpperCase());
  },

  // 输入长度验证
  isValidLength(str, min, max) {
    if (typeof str !== 'string') return false;
    const len = str.length;
    return len >= min && len <= max;
  },

  // 非空验证
  isNotEmpty(str) {
    return str !== null && str !== undefined && String(str).trim().length > 0;
  },

  // 验证码验证（6位数字）
  isVerifyCode(code) {
    if (!code || typeof code !== 'string') return false;
    return /^\d{6}$/.test(code.trim());
  },

  // URL 验证
  isURL(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },

  // 用户名验证（4-20位字母数字下划线）
  isUsername(username) {
    if (!username || typeof username !== 'string') return false;
    return /^[a-zA-Z0-9_]{4,20}$/.test(username.trim());
  },
};

// ============================================================
// 测试用例
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function describe(suiteName, fn) {
  console.log(`\n${suiteName}`);
  fn();
}

// 手机号验证测试
describe('手机号验证', () => {
  test('有效手机号', () => {
    assert.strictEqual(Validators.isPhone('13812345678'), true);
    assert.strictEqual(Validators.isPhone('15912345678'), true);
    assert.strictEqual(Validators.isPhone('18812345678'), true);
  });

  test('无效手机号 - 位数不对', () => {
    assert.strictEqual(Validators.isPhone('1381234567'), false);
    assert.strictEqual(Validators.isPhone('138123456789'), false);
  });

  test('无效手机号 - 开头不对', () => {
    assert.strictEqual(Validators.isPhone('12812345678'), false);
    assert.strictEqual(Validators.isPhone('23812345678'), false);
  });

  test('无效手机号 - 包含非数字', () => {
    assert.strictEqual(Validators.isPhone('1381234567a'), false);
    assert.strictEqual(Validators.isPhone('138-1234-5678'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isPhone(''), false);
    assert.strictEqual(Validators.isPhone(null), false);
    assert.strictEqual(Validators.isPhone(undefined), false);
  });
});

// 邮箱验证测试
describe('邮箱验证', () => {
  test('有效邮箱', () => {
    assert.strictEqual(Validators.isEmail('test@example.com'), true);
    assert.strictEqual(Validators.isEmail('user.name@domain.co.uk'), true);
    assert.strictEqual(Validators.isEmail('user+tag@example.com'), true);
  });

  test('无效邮箱 - 缺少@', () => {
    assert.strictEqual(Validators.isEmail('testexample.com'), false);
  });

  test('无效邮箱 - 缺少域名', () => {
    assert.strictEqual(Validators.isEmail('test@'), false);
  });

  test('无效邮箱 - 缺少用户名', () => {
    assert.strictEqual(Validators.isEmail('@example.com'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isEmail(''), false);
    assert.strictEqual(Validators.isEmail(null), false);
  });
});

// 密码强度验证测试
describe('密码强度验证', () => {
  test('有效密码', () => {
    assert.strictEqual(Validators.isPasswordStrong('Test1234'), true);
    assert.strictEqual(Validators.isPasswordStrong('abc12345'), true);
    assert.strictEqual(Validators.isPasswordStrong('ABCDE12345'), true);
  });

  test('无效密码 - 太短', () => {
    assert.strictEqual(Validators.isPasswordStrong('Test123'), false);
  });

  test('无效密码 - 太长', () => {
    assert.strictEqual(Validators.isPasswordStrong('Test12345678901234567890'), false);
  });

  test('无效密码 - 只有字母', () => {
    assert.strictEqual(Validators.isPasswordStrong('TestTest'), false);
  });

  test('无效密码 - 只有数字', () => {
    assert.strictEqual(Validators.isPasswordStrong('12345678'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isPasswordStrong(''), false);
    assert.strictEqual(Validators.isPasswordStrong(null), false);
  });
});

// 身份证号验证测试
describe('身份证号验证', () => {
  test('有效身份证号', () => {
    // 使用测试用身份证号（校验码正确）
    assert.strictEqual(Validators.isIDCard('110101199003078888'), true);
    assert.strictEqual(Validators.isIDCard('11010119900307888X'), true);
  });

  test('无效身份证号 - 位数不对', () => {
    assert.strictEqual(Validators.isIDCard('11010119900307888'), false);
    assert.strictEqual(Validators.isIDCard('1101011990030788888'), false);
  });

  test('无效身份证号 - 校验码错误', () => {
    assert.strictEqual(Validators.isIDCard('110101199003078881'), false);
  });

  test('无效身份证号 - 包含非法字符', () => {
    assert.strictEqual(Validators.isIDCard('11010119900307888A'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isIDCard(''), false);
    assert.strictEqual(Validators.isIDCard(null), false);
  });
});

// 设备序列号验证测试
describe('设备序列号验证', () => {
  test('有效序列号', () => {
    assert.strictEqual(Validators.isDeviceSN('DEV-20260101-0001'), true);
    assert.strictEqual(Validators.isDeviceSN('dev-20260101-0001'), true); // 不区分大小写
  });

  test('无效序列号 - 格式不对', () => {
    assert.strictEqual(Validators.isDeviceSN('DEVICE-20260101-0001'), false);
    assert.strictEqual(Validators.isDeviceSN('DEV-202601010001'), false);
    assert.strictEqual(Validators.isDeviceSN('DEV-2026-01-0001'), false);
  });

  test('无效序列号 - 日期不对', () => {
    assert.strictEqual(Validators.isDeviceSN('DEV-20261301-0001'), false); // 月份13
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isDeviceSN(''), false);
    assert.strictEqual(Validators.isDeviceSN(null), false);
  });
});

// 验证码验证测试
describe('验证码验证', () => {
  test('有效验证码', () => {
    assert.strictEqual(Validators.isVerifyCode('123456'), true);
    assert.strictEqual(Validators.isVerifyCode('000000'), true);
  });

  test('无效验证码 - 位数不对', () => {
    assert.strictEqual(Validators.isVerifyCode('12345'), false);
    assert.strictEqual(Validators.isVerifyCode('1234567'), false);
  });

  test('无效验证码 - 包含非数字', () => {
    assert.strictEqual(Validators.isVerifyCode('12345a'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isVerifyCode(''), false);
    assert.strictEqual(Validators.isVerifyCode(null), false);
  });
});

// 用户名验证测试
describe('用户名验证', () => {
  test('有效用户名', () => {
    assert.strictEqual(Validators.isUsername('test_user'), true);
    assert.strictEqual(Validators.isUsername('Test123'), true);
    assert.strictEqual(Validators.isUsername('a_b_c'), true);
  });

  test('无效用户名 - 太短', () => {
    assert.strictEqual(Validators.isUsername('abc'), false);
  });

  test('无效用户名 - 太长', () => {
    assert.strictEqual(Validators.isUsername('a'.repeat(21)), false);
  });

  test('无效用户名 - 包含特殊字符', () => {
    assert.strictEqual(Validators.isUsername('test user'), false);
    assert.strictEqual(Validators.isUsername('test@user'), false);
    assert.strictEqual(Validators.isUsername('test-user'), false);
  });

  test('空值处理', () => {
    assert.strictEqual(Validators.isUsername(''), false);
    assert.strictEqual(Validators.isUsername(null), false);
  });
});

// 非空验证测试
describe('非空验证', () => {
  test('非空值', () => {
    assert.strictEqual(Validators.isNotEmpty('test'), true);
    assert.strictEqual(Validators.isNotEmpty('  test  '), true);
    assert.strictEqual(Validators.isNotEmpty(0), true);
    assert.strictEqual(Validators.isNotEmpty(false), true);
  });

  test('空值', () => {
    assert.strictEqual(Validators.isNotEmpty(''), false);
    assert.strictEqual(Validators.isNotEmpty('   '), false);
    assert.strictEqual(Validators.isNotEmpty(null), false);
    assert.strictEqual(Validators.isNotEmpty(undefined), false);
  });
});

// 长度验证测试
describe('长度验证', () => {
  test('有效长度', () => {
    assert.strictEqual(Validators.isValidLength('test', 2, 10), true);
    assert.strictEqual(Validators.isValidLength('a', 1, 1), true);
  });

  test('太短', () => {
    assert.strictEqual(Validators.isValidLength('a', 2, 10), false);
  });

  test('太长', () => {
    assert.strictEqual(Validators.isValidLength('test', 1, 3), false);
  });

  test('非字符串', () => {
    assert.strictEqual(Validators.isValidLength(null, 1, 10), false);
    assert.strictEqual(Validators.isValidLength(undefined, 1, 10), false);
  });
});

// ============================================================
// 测试结果汇总
// ============================================================

console.log('\n' + '='.repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n所有测试通过！');
  process.exit(0);
}
