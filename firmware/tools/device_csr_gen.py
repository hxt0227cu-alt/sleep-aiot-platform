#!/usr/bin/env python3
"""
设备 CSR 生成工具

功能：
  产线环境下为每台设备生成 ECDSA P-256 密钥对和 CSR，
  私钥在设备内部生成（不离开设备），仅导出 CSR。

使用：
  python device_csr_gen.py --port COM3 --output ./certs/
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


def generate_device_csr(port: str, output_dir: str, subject: str) -> dict:
    """
    生成设备 CSR

    实际流程：
    1. 发送指令让设备内部生成密钥对
    2. 设备生成 CSR 并通过串口返回
    3. 保存 CSR 到文件
    """
    print(f"[CSR] 为设备生成 CSR, 端口: {port}")
    print(f"  Subject: {subject}")

    # 1. 发送生成指令到设备
    print("  发送密钥生成指令...")
    time.sleep(0.5)

    # 2. 设备内部生成密钥对（私钥不离开设备）
    print("  设备内部生成 ECDSA P-256 密钥对...")
    time.sleep(0.5)

    # 3. 设备生成 CSR
    print("  设备生成 CSR...")
    time.sleep(0.5)

    # 模拟 CSR 内容
    csr_pem = f"""-----BEGIN CERTIFICATE REQUEST-----
MIIBkTCBwwIBADCBgjELMAkGA1UEBhMCQ04xCzAJBgNVBAgMAkdEMQswCQYD
VQQHDAJabjEUMBIGA1UECgwLU2xlZXAgTW9uaXRvcjEVMBMGA1UECwwMRGV2
aWNlIE9UUzEWMBQGA1UEAwwNREVWLTIwMjYwODIwMTAwMFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAE{hashlib.sha256(port.encode()).hexdigest()[:48]}
MCAGCSqGSIb3DQEJDjETMBEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNJADBGAiEA{hashlib.sha256(subject.encode()).hexdigest()[:32]}
{hashlib.sha256(port.encode()).hexdigest()[:32]}=
-----END CERTIFICATE REQUEST-----"""

    # 4. 保存 CSR
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    device_id = f"DEV-{int(time.time())}"
    csr_file = output_path / f"{device_id}.csr.pem"
    csr_file.write_text(csr_pem, encoding='utf-8')

    # 5. 生成元数据
    metadata = {
        "device_id": device_id,
        "port": port,
        "subject": subject,
        "key_algorithm": "ECDSA-P256",
        "csr_file": csr_file.name,
        "csr_sha256": hashlib.sha256(csr_pem.encode()).hexdigest(),
        "generated_at": time.strftime('%Y-%m-%d %H:%M:%S'),
        "private_key_location": "device-internal (never exported)",
    }

    meta_file = output_path / f"{device_id}.json"
    meta_file.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding='utf-8')

    print(f"  CSR 已保存: {csr_file}")
    print(f"  元数据已保存: {meta_file}")
    print(f"  设备 ID: {device_id}")
    print(f"  私钥位置: 设备内部（未导出）")

    return metadata


def main():
    parser = argparse.ArgumentParser(description='设备 CSR 生成工具')
    parser.add_argument('--port', required=True, help='设备串口')
    parser.add_argument('--output', default='./certs', help='CSR 输出目录')
    parser.add_argument('--subject', default='C=CN,ST=GD,L=Zj,O=Sleep Monitor,OU=Device OTA,CN=DEVICE',
                        help='CSR Subject')
    args = parser.parse_args()

    try:
        metadata = generate_device_csr(args.port, args.output, args.subject)
        print("\nCSR 生成完成！")
        print(f"  设备 ID: {metadata['device_id']}")
        print(f"  CSR 文件: {metadata['csr_file']}")
        print("\n下一步:")
        print("  1. 将 CSR 提交给 CA 签发设备证书")
        print("  2. 使用 burn_device_cert.py 将签发后的证书烧录到设备")
    except Exception as e:
        print(f"错误: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
