#!/usr/bin/env python3
"""
产线密钥注入审计工具

功能：
  1. 审计产线密钥注入过程的完整性和合规性
  2. 验证每台设备的密钥注入记录
  3. 检查是否有未授权的密钥注入操作
  4. 生成审计报告

使用：
  python key-injection-audit.py --log-dir <日志目录> --output <报告路径>
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional


class KeyInjectionAuditor:
    """密钥注入审计器"""

    def __init__(self, log_dir: str, output_path: Optional[str] = None):
        self.log_dir = Path(log_dir)
        self.output_path = Path(output_path) if output_path else None
        self.records: List[Dict] = []
        self.findings: List[Dict] = []
        self.stats = {
            'total_records': 0,
            'successful': 0,
            'failed': 0,
            'duplicate_device_ids': 0,
            'unauthorized_operations': 0,
            'missing_fields': 0,
        }

    def load_records(self) -> None:
        """加载密钥注入记录"""
        if not self.log_dir.exists():
            print(f"[ERROR] 日志目录不存在: {self.log_dir}")
            sys.exit(1)

        log_files = list(self.log_dir.glob('**/*.json')) + list(self.log_dir.glob('**/*.log'))
        print(f"[INFO] 找到 {len(log_files)} 个日志文件")

        for log_file in log_files:
            try:
                if log_file.suffix == '.json':
                    with open(log_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            self.records.extend(data)
                        elif isinstance(data, dict):
                            self.records.append(data)
                else:
                    # 解析 JSON Lines 格式
                    with open(log_file, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                try:
                                    self.records.append(json.loads(line))
                                except json.JSONDecodeError:
                                    continue
            except Exception as e:
                print(f"[WARNING] 解析文件失败 {log_file}: {e}")

        self.stats['total_records'] = len(self.records)
        print(f"[INFO] 加载了 {len(self.records)} 条记录")

    def validate_record_fields(self, record: Dict) -> List[str]:
        """验证记录字段完整性"""
        required_fields = [
            'device_id', 'serial_number', 'key_type', 'injection_time',
            'operator', 'workstation_id', 'status',
        ]
        missing = []
        for field in required_fields:
            if field not in record or record[field] in (None, '', 'null'):
                missing.append(field)
        return missing

    def check_duplicates(self) -> None:
        """检查重复的设备 ID"""
        device_ids = {}
        for record in self.records:
            device_id = record.get('device_id')
            if device_id:
                if device_id in device_ids:
                    device_ids[device_id].append(record)
                else:
                    device_ids[device_id] = [record]

        for device_id, records in device_ids.items():
            if len(records) > 1:
                # 检查是否有多次成功注入
                successful = [r for r in records if r.get('status') == 'success']
                if len(successful) > 1:
                    self.stats['duplicate_device_ids'] += 1
                    self.findings.append({
                        'severity': 'high',
                        'type': 'duplicate_key_injection',
                        'device_id': device_id,
                        'message': f'设备 {device_id} 有 {len(successful)} 次成功的密钥注入',
                        'records': successful,
                    })

    def check_unauthorized_operations(self) -> None:
        """检查未授权操作"""
        authorized_operators = {'operator_001', 'operator_002', 'operator_003', 'admin'}
        authorized_workstations = {'WS-001', 'WS-002', 'WS-003'}

        for record in self.records:
            operator = record.get('operator', '')
            workstation = record.get('workstation_id', '')

            if operator and operator not in authorized_operators:
                self.stats['unauthorized_operations'] += 1
                self.findings.append({
                    'severity': 'critical',
                    'type': 'unauthorized_operator',
                    'device_id': record.get('device_id'),
                    'operator': operator,
                    'message': f'未授权的操作员: {operator}',
                    'record': record,
                })

            if workstation and workstation not in authorized_workstations:
                self.stats['unauthorized_operations'] += 1
                self.findings.append({
                    'severity': 'high',
                    'type': 'unauthorized_workstation',
                    'device_id': record.get('device_id'),
                    'workstation': workstation,
                    'message': f'未授权的工作站: {workstation}',
                    'record': record,
                })

    def check_time_anomalies(self) -> None:
        """检查时间异常"""
        for record in self.records:
            injection_time = record.get('injection_time')
            if injection_time:
                try:
                    dt = datetime.fromisoformat(injection_time.replace('Z', '+00:00'))
                    # 检查是否在非工作时间（凌晨 0-6 点）
                    if dt.hour < 6:
                        self.findings.append({
                            'severity': 'medium',
                            'type': 'off_hours_operation',
                            'device_id': record.get('device_id'),
                            'injection_time': injection_time,
                            'message': f'非工作时间操作: {injection_time}',
                            'record': record,
                        })
                except (ValueError, TypeError):
                    pass

    def check_key_types(self) -> None:
        """检查密钥类型合规性"""
        valid_key_types = {'device_cert', 'device_key', 'root_key', 'session_key'}
        for record in self.records:
            key_type = record.get('key_type', '')
            if key_type and key_type not in valid_key_types:
                self.findings.append({
                    'severity': 'medium',
                    'type': 'invalid_key_type',
                    'device_id': record.get('device_id'),
                    'key_type': key_type,
                    'message': f'无效的密钥类型: {key_type}',
                    'record': record,
                })

    def audit(self) -> None:
        """执行完整审计"""
        print("[INFO] 开始审计...")

        # 验证每条记录
        for record in self.records:
            missing = self.validate_record_fields(record)
            if missing:
                self.stats['missing_fields'] += 1
                self.findings.append({
                    'severity': 'medium',
                    'type': 'missing_fields',
                    'device_id': record.get('device_id', 'unknown'),
                    'missing_fields': missing,
                    'message': f'记录缺少字段: {", ".join(missing)}',
                })

            if record.get('status') == 'success':
                self.stats['successful'] += 1
            elif record.get('status') == 'failed':
                self.stats['failed'] += 1

        # 检查重复
        self.check_duplicates()

        # 检查未授权操作
        self.check_unauthorized_operations()

        # 检查时间异常
        self.check_time_anomalies()

        # 检查密钥类型
        self.check_key_types()

        print(f"[INFO] 审计完成，发现 {len(self.findings)} 个问题")

    def generate_report(self) -> str:
        """生成审计报告"""
        severity_counts = {'critical': 0, 'high': 0, 'medium': 0, 'low': 0}
        for finding in self.findings:
            severity = finding.get('severity', 'low')
            severity_counts[severity] = severity_counts.get(severity, 0) + 1

        report = {
            'audit_time': datetime.now().isoformat(),
            'log_directory': str(self.log_dir),
            'summary': {
                'total_records': self.stats['total_records'],
                'successful': self.stats['successful'],
                'failed': self.stats['failed'],
                'success_rate': (
                    self.stats['successful'] / self.stats['total_records'] * 100
                    if self.stats['total_records'] > 0 else 0
                ),
            },
            'issues': {
                'total': len(self.findings),
                'by_severity': severity_counts,
                'duplicate_device_ids': self.stats['duplicate_device_ids'],
                'unauthorized_operations': self.stats['unauthorized_operations'],
                'missing_fields': self.stats['missing_fields'],
            },
            'findings': self.findings[:100],  # 最多保留100条详细记录
            'conclusion': self._generate_conclusion(severity_counts),
        }

        return json.dumps(report, indent=2, ensure_ascii=False)

    def _generate_conclusion(self, severity_counts: Dict[str, int]) -> str:
        """生成审计结论"""
        if severity_counts.get('critical', 0) > 0:
            return '不通过 - 发现严重问题，需要立即调查和整改'
        elif severity_counts.get('high', 0) > 0:
            return '有条件通过 - 发现高优先级问题，需要限期整改'
        elif severity_counts.get('medium', 0) > 0:
            return '通过 - 发现中等优先级问题，建议改进'
        else:
            return '通过 - 未发现严重问题'

    def save_report(self, report: str) -> None:
        """保存报告"""
        if self.output_path:
            self.output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.output_path, 'w', encoding='utf-8') as f:
                f.write(report)
            print(f"[INFO] 报告已保存: {self.output_path}")
        else:
            print(report)

    def print_summary(self) -> None:
        """打印摘要"""
        print("\n" + "=" * 60)
        print("  密钥注入审计摘要")
        print("=" * 60)
        print(f"  总记录数: {self.stats['total_records']}")
        print(f"  成功: {self.stats['successful']}")
        print(f"  失败: {self.stats['failed']}")
        if self.stats['total_records'] > 0:
            print(f"  成功率: {self.stats['successful'] / self.stats['total_records'] * 100:.2f}%")
        print(f"  发现问题: {len(self.findings)}")
        print(f"    - 重复设备 ID: {self.stats['duplicate_device_ids']}")
        print(f"    - 未授权操作: {self.stats['unauthorized_operations']}")
        print(f"    - 缺少字段: {self.stats['missing_fields']}")
        print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description='产线密钥注入审计工具')
    parser.add_argument('--log-dir', required=True, help='密钥注入日志目录')
    parser.add_argument('--output', help='审计报告输出路径（JSON格式）')
    parser.add_argument('--summary-only', action='store_true', help='仅输出摘要')

    args = parser.parse_args()

    auditor = KeyInjectionAuditor(args.log_dir, args.output)
    auditor.load_records()
    auditor.audit()

    if args.summary_only:
        auditor.print_summary()
    else:
        report = auditor.generate_report()
        auditor.save_report(report)
        auditor.print_summary()


if __name__ == '__main__':
    main()
