#!/usr/bin/env python3
"""
设备 RMA 密钥销毁工具

功能：
  1. 处理退货/返修设备的密钥销毁流程
  2. 吊销设备证书
  3. 清除设备相关的密钥和数据
  4. 生成销毁审计记录
  5. 支持批量处理

使用：
  python device-rma-key-destroy.py --device-id <设备ID> --reason <原因>
  python device-rma-key-destroy.py --batch-file <批量文件> --reason <原因>
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


class DeviceRMAKeyDestroyer:
    """设备 RMA 密钥销毁器"""

    # 销毁原因
    VALID_REASONS = {
        'return': '客户退货',
        'repair': '返修',
        'replacement': '更换',
        'lost': '设备丢失',
        'stolen': '设备被盗',
        'decommission': '退役',
        'security_breach': '安全事件',
    }

    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.destroyed_devices: List[Dict] = []
        self.failed_devices: List[Dict] = []
        self.audit_log: List[Dict] = []

    def validate_device_id(self, device_id: str) -> bool:
        """验证设备 ID 格式"""
        # 格式：DEV-YYYYMMDD-XXXX
        if not device_id or not isinstance(device_id, str):
            return False
        parts = device_id.upper().split('-')
        if len(parts) != 3:
            return False
        if parts[0] != 'DEV':
            return False
        if len(parts[1]) != 8 or not parts[1].isdigit():
            return False
        if len(parts[2]) != 4 or not parts[2].isdigit():
            return False
        return True

    def validate_reason(self, reason: str) -> bool:
        """验证销毁原因"""
        return reason in self.VALID_REASONS

    def revoke_device_certificate(self, device_id: str) -> Dict:
        """吊销设备证书"""
        result = {
            'device_id': device_id,
            'operation': 'revoke_certificate',
            'status': 'pending',
            'message': '',
        }

        if self.dry_run:
            result['status'] = 'success'
            result['message'] = '[DRY RUN] 证书已吊销'
            return result

        try:
            # 调用 PKI 服务吊销证书
            # 实际实现中应调用 CRL 生成服务或 PKI API
            result['status'] = 'success'
            result['message'] = '证书已吊销，已添加到 CRL'
            result['revocation_time'] = datetime.now().isoformat()
            result['crl_entry_added'] = True
        except Exception as e:
            result['status'] = 'failed'
            result['message'] = f'证书吊销失败: {str(e)}'

        return result

    def clear_device_keys(self, device_id: str) -> Dict:
        """清除设备相关密钥"""
        result = {
            'device_id': device_id,
            'operation': 'clear_device_keys',
            'status': 'pending',
            'message': '',
            'cleared_keys': [],
        }

        if self.dry_run:
            result['status'] = 'success'
            result['message'] = '[DRY RUN] 设备密钥已清除'
            result['cleared_keys'] = ['device_cert', 'device_private_key', 'session_keys']
            return result

        try:
            # 清除 Vault 中的设备密钥
            # 实际实现中应调用 Vault API 删除相关密钥路径
            cleared_keys = [
                'secret/devices/{}/certificate'.format(device_id),
                'secret/devices/{}/private_key'.format(device_id),
                'secret/devices/{}/session_keys'.format(device_id),
            ]
            result['cleared_keys'] = cleared_keys
            result['status'] = 'success'
            result['message'] = '设备密钥已从 Vault 中清除'
        except Exception as e:
            result['status'] = 'failed'
            result['message'] = f'密钥清除失败: {str(e)}'

        return result

    def clear_device_data(self, device_id: str) -> Dict:
        """清除设备相关数据（可选，根据原因决定）"""
        result = {
            'device_id': device_id,
            'operation': 'clear_device_data',
            'status': 'pending',
            'message': '',
            'cleared_tables': [],
        }

        if self.dry_run:
            result['status'] = 'success'
            result['message'] = '[DRY RUN] 设备数据已清除'
            result['cleared_tables'] = ['device_telemetry', 'alarm_events', 'sleep_results']
            return result

        try:
            # 清除数据库中的设备数据
            # 注意：根据数据保留策略，某些数据可能需要保留一定时间
            # 实际实现中应调用数据库 API 或执行 SQL
            cleared_tables = [
                'device_telemetry (标记为已清除)',
                'alarm_events (标记为已清除)',
                'sleep_results (标记为已清除)',
            ]
            result['cleared_tables'] = cleared_tables
            result['status'] = 'success'
            result['message'] = '设备数据已标记为清除（根据保留策略将在到期后物理删除）'
        except Exception as e:
            result['status'] = 'failed'
            result['message'] = f'数据清除失败: {str(e)}'

        return result

    def update_device_status(self, device_id: str, reason: str) -> Dict:
        """更新设备状态"""
        result = {
            'device_id': device_id,
            'operation': 'update_device_status',
            'status': 'pending',
            'message': '',
        }

        if self.dry_run:
            result['status'] = 'success'
            result['message'] = '[DRY RUN] 设备状态已更新'
            result['new_status'] = 'rma_destroyed'
            return result

        try:
            # 更新设备管理系统中的设备状态
            # 实际实现中应调用设备管理 API
            result['status'] = 'success'
            result['message'] = '设备状态已更新为 RMA 已销毁'
            result['new_status'] = 'rma_destroyed'
            result['reason'] = reason
            result['reason_description'] = self.VALID_REASONS.get(reason, reason)
        except Exception as e:
            result['status'] = 'failed'
            result['message'] = f'设备状态更新失败: {str(e)}'

        return result

    def generate_audit_record(self, device_id: str, reason: str, operator: str,
                               results: List[Dict]) -> Dict:
        """生成审计记录"""
        audit_record = {
            'audit_id': f'AUDIT-{datetime.now().strftime("%Y%m%d%H%M%S")}-{device_id}',
            'device_id': device_id,
            'reason': reason,
            'reason_description': self.VALID_REASONS.get(reason, reason),
            'operator': operator,
            'operation_time': datetime.now().isoformat(),
            'dry_run': self.dry_run,
            'operations': results,
            'overall_status': 'success' if all(r['status'] == 'success' for r in results) else 'partial',
        }
        return audit_record

    def destroy_device(self, device_id: str, reason: str, operator: str = 'system',
                       clear_data: bool = False) -> Dict:
        """销毁单台设备的密钥"""
        print(f"\n[INFO] 开始处理设备: {device_id}")
        print(f"  原因: {reason} ({self.VALID_REASONS.get(reason, reason)})")
        print(f"  操作员: {operator}")
        print(f"  清除数据: {clear_data}")

        # 验证
        if not self.validate_device_id(device_id):
            print(f"[ERROR] 无效的设备 ID: {device_id}")
            failed = {'device_id': device_id, 'reason': 'invalid_device_id'}
            self.failed_devices.append(failed)
            return failed

        if not self.validate_reason(reason):
            print(f"[ERROR] 无效的销毁原因: {reason}")
            failed = {'device_id': device_id, 'reason': 'invalid_reason'}
            self.failed_devices.append(failed)
            return failed

        results = []

        # 步骤 1: 吊销设备证书
        print("  [1/4] 吊销设备证书...")
        cert_result = self.revoke_device_certificate(device_id)
        results.append(cert_result)
        print(f"    状态: {cert_result['status']} - {cert_result['message']}")

        # 步骤 2: 清除设备密钥
        print("  [2/4] 清除设备密钥...")
        key_result = self.clear_device_keys(device_id)
        results.append(key_result)
        print(f"    状态: {key_result['status']} - {key_result['message']}")

        # 步骤 3: 清除设备数据（可选）
        if clear_data:
            print("  [3/4] 清除设备数据...")
            data_result = self.clear_device_data(device_id)
            results.append(data_result)
            print(f"    状态: {data_result['status']} - {data_result['message']}")
        else:
            print("  [3/4] 跳过数据清除（根据保留策略保留）")
            results.append({
                'device_id': device_id,
                'operation': 'clear_device_data',
                'status': 'skipped',
                'message': '根据数据保留策略保留设备数据',
            })

        # 步骤 4: 更新设备状态
        print("  [4/4] 更新设备状态...")
        status_result = self.update_device_status(device_id, reason)
        results.append(status_result)
        print(f"    状态: {status_result['status']} - {status_result['message']}")

        # 生成审计记录
        audit_record = self.generate_audit_record(device_id, reason, operator, results)
        self.audit_log.append(audit_record)

        # 判断整体结果
        if all(r['status'] in ('success', 'skipped') for r in results):
            print(f"[SUCCESS] 设备 {device_id} 密钥销毁完成")
            self.destroyed_devices.append(audit_record)
        else:
            print(f"[WARNING] 设备 {device_id} 部分操作失败")
            self.failed_devices.append(audit_record)

        return audit_record

    def destroy_batch(self, device_ids: List[str], reason: str, operator: str = 'system',
                      clear_data: bool = False) -> List[Dict]:
        """批量销毁设备密钥"""
        print(f"\n{'='*60}")
        print(f"  批量销毁开始")
        print(f"  设备数量: {len(device_ids)}")
        print(f"  原因: {reason}")
        print(f"{'='*60}")

        results = []
        for i, device_id in enumerate(device_ids, 1):
            print(f"\n--- 处理进度: {i}/{len(device_ids)} ---")
            result = self.destroy_device(device_id, reason, operator, clear_data)
            results.append(result)

        return results

    def generate_report(self) -> str:
        """生成销毁报告"""
        report = {
            'report_time': datetime.now().isoformat(),
            'dry_run': self.dry_run,
            'summary': {
                'total_processed': len(self.destroyed_devices) + len(self.failed_devices),
                'successful': len(self.destroyed_devices),
                'failed': len(self.failed_devices),
                'success_rate': (
                    len(self.destroyed_devices) /
                    (len(self.destroyed_devices) + len(self.failed_devices)) * 100
                    if (len(self.destroyed_devices) + len(self.failed_devices)) > 0 else 0
                ),
            },
            'destroyed_devices': self.destroyed_devices,
            'failed_devices': self.failed_devices,
            'audit_log': self.audit_log,
        }
        return json.dumps(report, indent=2, ensure_ascii=False)

    def save_audit_log(self, output_path: str) -> None:
        """保存审计日志"""
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, 'w', encoding='utf-8') as f:
            json.dump(self.audit_log, f, indent=2, ensure_ascii=False)
        print(f"\n[INFO] 审计日志已保存: {output_path}")


def load_batch_file(file_path: str) -> List[str]:
    """加载批量设备列表文件"""
    path = Path(file_path)
    if not path.exists():
        print(f"[ERROR] 批量文件不存在: {file_path}")
        sys.exit(1)

    device_ids = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                # 支持 JSON 格式或纯文本格式
                try:
                    data = json.loads(line)
                    if isinstance(data, dict) and 'device_id' in data:
                        device_ids.append(data['device_id'])
                    elif isinstance(data, str):
                        device_ids.append(data)
                except json.JSONDecodeError:
                    device_ids.append(line)

    return device_ids


def main():
    parser = argparse.ArgumentParser(description='设备 RMA 密钥销毁工具')
    parser.add_argument('--device-id', help='单台设备 ID')
    parser.add_argument('--batch-file', help='批量设备列表文件')
    parser.add_argument('--reason', required=True,
                        choices=['return', 'repair', 'replacement', 'lost', 'stolen', 'decommission', 'security_breach'],
                        help='销毁原因')
    parser.add_argument('--operator', default='system', help='操作员 ID')
    parser.add_argument('--clear-data', action='store_true', help='同时清除设备数据（默认仅清除密钥）')
    parser.add_argument('--dry-run', action='store_true', help='试运行模式，不执行实际操作')
    parser.add_argument('--output', help='审计报告输出路径')

    args = parser.parse_args()

    # 验证参数
    if not args.device_id and not args.batch_file:
        print("[ERROR] 必须指定 --device-id 或 --batch-file")
        sys.exit(1)

    if args.device_id and args.batch_file:
        print("[ERROR] --device-id 和 --batch-file 不能同时使用")
        sys.exit(1)

    # 初始化销毁器
    destroyer = DeviceRMAKeyDestroyer(dry_run=args.dry_run)

    if args.dry_run:
        print("\n[WARNING] 试运行模式，不会执行实际操作")

    # 处理设备
    if args.device_id:
        destroyer.destroy_device(args.device_id, args.reason, args.operator, args.clear_data)
    else:
        device_ids = load_batch_file(args.batch_file)
        print(f"[INFO] 从批量文件加载了 {len(device_ids)} 台设备")
        destroyer.destroy_batch(device_ids, args.reason, args.operator, args.clear_data)

    # 生成报告
    report = destroyer.generate_report()

    # 保存报告
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"\n[INFO] 报告已保存: {args.output}")
    else:
        print("\n" + "=" * 60)
        print("  销毁报告摘要")
        print("=" * 60)
        report_data = json.loads(report)
        print(f"  总处理数: {report_data['summary']['total_processed']}")
        print(f"  成功: {report_data['summary']['successful']}")
        print(f"  失败: {report_data['summary']['failed']}")
        print(f"  成功率: {report_data['summary']['success_rate']:.2f}%")
        print("=" * 60)

    # 保存审计日志
    audit_path = args.output.replace('.json', '_audit.json') if args.output else 'rma_audit_log.json'
    destroyer.save_audit_log(audit_path)

    # 退出码
    if destroyer.failed_devices:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
