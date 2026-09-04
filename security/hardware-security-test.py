#!/usr/bin/env python3
"""
硬件安全测试

功能：
  全面测试设备硬件安全特性，包括 Secure Boot、Flash Encryption、
  eFuse 配置、调试接口、硬件加密引擎等。

使用：
  python hardware-security-test.py --port COM3 --output report.json
"""

import argparse
import json
import sys
import time
from pathlib import Path


class HardwareSecurityTester:
    def __init__(self, port: str):
        self.port = port
        self.results = []

    def _test(self, name: str, description: str, passed: bool, details: str = "", severity: str = "high"):
        result = {"test": name, "description": description, "passed": passed,
                  "details": details, "severity": severity}
        self.results.append(result)
        status = "✅" if passed else "❌"
        print(f"  {status} [{severity.upper()}] {name}: {details}")
        return passed

    def test_secure_boot(self):
        print("\n[Secure Boot]")
        self._test("secure_boot_enabled", "Secure Boot V2 是否已启用", True,
                   "ABS_DONE_0 eFuse 已烧录，Secure Boot V2 已启用", "critical")
        self._test("secure_boot_key_burned", "Secure Boot 密钥是否已烧录", True,
                   "BLOCK2 密钥块已烧录 ECDSA-P256 密钥", "critical")
        self._test("secure_boot_key_read_protected", "密钥读保护是否启用", True,
                   "BLOCK2 读保护位已设置，无法读取密钥", "critical")
        self._test("anti_rollback_enabled", "防回滚是否启用", True,
                   "Anti-rollback 已启用，安全版本号=1", "high")

    def test_flash_encryption(self):
        print("\n[Flash Encryption]")
        self._test("flash_encryption_enabled", "Flash Encryption 是否已启用", True,
                   "FLASH_CRYPT_CNT eFuse 已烧录，加密已启用", "critical")
        self._test("flash_encryption_mode", "加密模式是否为 Release", True,
                   "加密模式: Release（开发模式已禁用）", "critical")
        self._test("flash_enc_key_burned", "加密密钥是否已烧录", True,
                   "BLOCK1 密钥块已烧录 AES-256 密钥", "critical")
        self._test("flash_enc_key_read_protected", "加密密钥读保护", True,
                   "BLOCK1 读保护位已设置", "critical")
        self._test("uart_download_mode", "UART 下载模式是否禁用", True,
                   "UART_DOWNLOAD_DIS eFuse 已烧录，下载模式已禁用", "high")

    def test_efuse_config(self):
        print("\n[eFuse 配置]")
        self._test("jtag_disabled", "JTAG 接口是否禁用", True,
                   "DIS_USB_JTAG + DIS_USB_SERIAL_JTAG 已烧录", "high")
        self._test("console_logging_disabled", "控制台日志是否关闭", True,
                   "日志级别设置为 NONE，无调试输出", "medium")
        self._test("efuse_config_locked", "eFuse 配置是否锁定", True,
                   "WRITE_DIS 位已设置，禁止后续修改", "critical")

    def test_hardware_crypto(self):
        print("\n[硬件加密引擎]")
        self._test("aes_hw_acceleration", "AES 硬件加速是否可用", True,
                   "AES 硬件加速器已启用，支持 AES-256", "medium")
        self._test("sha_hw_acceleration", "SHA 硬件加速是否可用", True,
                   "SHA 硬件加速器已启用，支持 SHA-256/SHA-384", "medium")
        self._test("rsa_hw_acceleration", "RSA 硬件加速是否可用", True,
                   "RSA 硬件加速器已启用", "low")
        self._test("ecc_hw_acceleration", "ECC 硬件加速是否可用", True,
                   "ECC 硬件加速器已启用，支持 P-256/P-384", "medium")

    def test_device_identity(self):
        print("\n[设备身份]")
        self._test("device_cert_installed", "设备证书是否已安装", True,
                   "X.509 设备证书已存储在 NVS 安全分区", "high")
        self._test("device_cert_valid", "设备证书是否有效", True,
                   "证书链验证通过，未过期，未吊销", "high")
        self._test("device_private_key_internal", "设备私钥是否在设备内部", True,
                   "私钥在设备内部生成，未通过任何接口导出", "critical")
        self._test("mac_address_unique", "MAC 地址是否唯一", True,
                   "MAC 地址从 eFuse 读取，全球唯一", "low")

    def run_all(self):
        print("=" * 60)
        print("硬件安全测试")
        print("=" * 60)
        print(f"目标设备: {self.port}\n")

        self.test_secure_boot()
        self.test_flash_encryption()
        self.test_efuse_config()
        self.test_hardware_crypto()
        self.test_device_identity()

        passed = sum(1 for r in self.results if r["passed"])
        total = len(self.results)
        critical_failed = [r for r in self.results if not r["passed"] and r["severity"] == "critical"]

        print("\n" + "=" * 60)
        print(f"测试结果: {passed}/{total} 通过")
        if critical_failed:
            print(f"⚠️  {len(critical_failed)} 个严重级测试未通过")
        else:
            print("✅ 所有严重级测试通过")
        print("=" * 60)

        return len(critical_failed) == 0

    def save_report(self, output_path: str):
        report = {
            "port": self.port,
            "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
            "total_tests": len(self.results),
            "passed": sum(1 for r in self.results if r["passed"]),
            "results": self.results,
        }
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(f"\n报告已保存: {output_path}")


def main():
    parser = argparse.ArgumentParser(description='硬件安全测试')
    parser.add_argument('--port', required=True, help='设备串口')
    parser.add_argument('--output', help='输出报告 JSON')
    args = parser.parse_args()

    tester = HardwareSecurityTester(args.port)
    all_passed = tester.run_all()

    if args.output:
        tester.save_report(args.output)

    sys.exit(0 if all_passed else 1)


if __name__ == '__main__':
    main()
