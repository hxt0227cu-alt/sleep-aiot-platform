#!/usr/bin/env python3
"""
离线固件签名工具

功能：
  在离线安全环境中使用 Secure Boot 私钥签名固件，
  支持 ECDSA-SHA256 算法和防回滚版本号。

安全要求：
  - 必须在离线安全环境中执行
  - 私钥文件应加密存储
  - 签名过程需要双人审批

使用：
  python firmware_sign_offline.py --input firmware.bin --key secure_boot_key.pem --output firmware-signed.bin
"""

import argparse
import hashlib
import json
import struct
import sys
import time
from pathlib import Path

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.exceptions import InvalidSignature
except ImportError:
    print("错误: 需要安装 cryptography 库")
    print("  pip install cryptography")
    sys.exit(1)


# Secure Boot V2 签名块结构
SIGNATURE_MAGIC = 0xE7
SIGNATURE_VERSION = 0x02
SECTOR_SIZE = 4096


def load_private_key(key_path: str, password: str = None):
    """加载 ECDSA 私钥"""
    key_file = Path(key_path)
    if not key_file.exists():
        raise FileNotFoundError(f"私钥文件不存在: {key_path}")

    key_data = key_file.read_bytes()

    try:
        private_key = serialization.load_pem_private_key(
            key_data,
            password=password.encode() if password else None,
        )
        if not isinstance(private_key, ec.EllipticCurvePrivateKey):
            raise ValueError("私钥不是 ECDSA 类型")
        if private_key.curve.key_size != 256:
            raise ValueError(f"需要 P-256 曲线，当前: {private_key.curve.key_size}")
        return private_key
    except Exception as e:
        raise ValueError(f"加载私钥失败: {e}")


def sign_firmware(input_path: str, output_path: str, key_path: str,
                  secure_version: int = 1, password: str = None) -> dict:
    """签名固件"""
    print("[Sign] 开始签名固件")
    print(f"  输入: {input_path}")
    print(f"  输出: {output_path}")
    print(f"  安全版本: {secure_version}")

    # 1. 加载私钥
    print("  加载签名私钥...")
    private_key = load_private_key(key_path, password)

    # 2. 读取固件
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"固件文件不存在: {input_path}")

    firmware_data = input_file.read_bytes()
    original_size = len(firmware_data)
    print(f"  固件大小: {original_size} bytes")

    # 3. 计算固件哈希（SHA-256）
    firmware_hash = hashlib.sha256(firmware_data).digest()
    print(f"  固件 SHA256: {firmware_hash.hex()}")

    # 4. 生成 ECDSA 签名
    print("  生成 ECDSA-SHA256 签名...")
    signature = private_key.sign(firmware_hash, ec.ECDSA(hashes.SHA256()))

    # DER 格式转 R+S 格式
    r, s = decode_dss_signature(signature)
    r_bytes = r.to_bytes(32, 'big')
    s_bytes = s.to_bytes(32, 'big')
    signature_raw = r_bytes + s_bytes

    # 5. 构建签名块（ESP32-S3 Secure Boot V2 格式）
    # 简化版签名块结构
    signature_block = bytearray()
    signature_block.append(SIGNATURE_MAGIC)      # magic
    signature_block.append(SIGNATURE_VERSION)    # version
    signature_block.append(0x00)                  # padding
    signature_block.append(0x00)                  # padding
    signature_block.extend(struct.pack('<I', secure_version))  # secure version
    signature_block.extend(struct.pack('<I', original_size))   # firmware size
    signature_block.extend(firmware_hash)         # firmware hash (32 bytes)
    signature_block.extend(signature_raw)         # signature (64 bytes)

    # 填充到扇区大小
    while len(signature_block) < SECTOR_SIZE:
        signature_block.append(0xFF)

    # 6. 合并签名块和固件
    signed_firmware = bytes(signature_block) + firmware_data

    # 7. 保存签名后的固件
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_bytes(signed_firmware)

    print(f"  签名块大小: {len(signature_block)} bytes")
    print(f"  签名后固件大小: {len(signed_firmware)} bytes")
    print(f"  已保存: {output_path}")

    # 8. 生成签名元数据
    metadata = {
        "input_file": input_file.name,
        "output_file": output_file.name,
        "original_size": original_size,
        "signed_size": len(signed_firmware),
        "firmware_sha256": firmware_hash.hex(),
        "signed_sha256": hashlib.sha256(signed_firmware).hexdigest(),
        "signature_algorithm": "ECDSA-SHA256-P256",
        "secure_version": secure_version,
        "signature_r": r_bytes.hex(),
        "signature_s": s_bytes.hex(),
        "signed_at": time.strftime('%Y-%m-%d %H:%M:%S'),
    }

    return metadata


def verify_signature(signed_path: str, pubkey_path: str) -> bool:
    """验证固件签名"""
    print("[Verify] 验证固件签名")

    signed_file = Path(signed_path)
    if not signed_file.exists():
        raise FileNotFoundError(f"签名固件不存在: {signed_path}")

    signed_data = signed_file.read_bytes()

    # 解析签名块
    if signed_data[0] != SIGNATURE_MAGIC:
        print("  错误: 签名块 Magic 不匹配")
        return False

    secure_version = struct.unpack('<I', signed_data[4:8])[0]
    firmware_size = struct.unpack('<I', signed_data[8:12])[0]
    firmware_hash = signed_data[12:44]
    signature_raw = signed_data[44:108]

    firmware_data = signed_data[SECTOR_SIZE:SECTOR_SIZE + firmware_size]

    # 验证哈希
    actual_hash = hashlib.sha256(firmware_data).digest()
    if actual_hash != firmware_hash:
        print("  错误: 固件哈希不匹配")
        return False

    # 加载公钥验证
    pubkey_file = Path(pubkey_path)
    if pubkey_file.exists():
        pubkey_data = pubkey_file.read_bytes()
        public_key = serialization.load_pem_public_key(pubkey_data)

        r = int.from_bytes(signature_raw[:32], 'big')
        s = int.from_bytes(signature_raw[32:], 'big')

        try:
            from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
            der_sig = encode_dss_signature(r, s)
            public_key.verify(der_sig, firmware_hash, ec.ECDSA(hashes.SHA256()))
            print("  签名验证: ✅ 通过")
        except InvalidSignature:
            print("  签名验证: ❌ 失败")
            return False

    print(f"  安全版本: {secure_version}")
    print(f"  固件大小: {firmware_size}")
    return True


def main():
    parser = argparse.ArgumentParser(
        description='离线固件签名工具 (ECDSA-SHA256 Secure Boot V2)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest='command', help='命令')

    # sign 命令
    sign_parser = subparsers.add_parser('sign', help='签名固件')
    sign_parser.add_argument('--input', required=True, help='输入固件文件')
    sign_parser.add_argument('--output', required=True, help='输出签名固件文件')
    sign_parser.add_argument('--key', required=True, help='ECDSA 私钥文件 (PEM)')
    sign_parser.add_argument('--password', help='私钥密码（如加密）')
    sign_parser.add_argument('--secure-version', type=int, default=1, help='防回滚安全版本号')

    # verify 命令
    verify_parser = subparsers.add_parser('verify', help='验证固件签名')
    verify_parser.add_argument('--input', required=True, help='签名固件文件')
    verify_parser.add_argument('--pubkey', help='公钥文件（可选）')

    args = parser.parse_args()

    if args.command == 'sign':
        try:
            metadata = sign_firmware(
                args.input, args.output, args.key,
                args.secure_version, args.password
            )
            print("\n签名完成！")
            print(f"  安全版本: {metadata['secure_version']}")
            print(f"  签名后 SHA256: {metadata['signed_sha256'][:16]}...")

            # 保存元数据
            meta_file = Path(args.output).with_suffix('.sign.json')
            meta_file.write_text(json.dumps(metadata, indent=2), encoding='utf-8')
            print(f"  元数据: {meta_file}")
        except Exception as e:
            print(f"错误: {e}")
            sys.exit(1)

    elif args.command == 'verify':
        try:
            valid = verify_signature(args.input, args.pubkey)
            sys.exit(0 if valid else 1)
        except Exception as e:
            print(f"错误: {e}")
            sys.exit(1)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
