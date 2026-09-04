#!/usr/bin/env python3
"""
报警准确率测试

功能：
  使用标注数据集验证边缘报警引擎的准确率，
  计算混淆矩阵、精确率、召回率、F1分数。
"""

import argparse
import json
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict


@dataclass
class ConfusionMatrix:
    tp: int = 0  # True Positive
    fp: int = 0  # False Positive
    fn: int = 0  # False Negative
    tn: int = 0  # True Negative

    @property
    def precision(self) -> float:
        if self.tp + self.fp == 0:
            return 0.0
        return self.tp / (self.tp + self.fp)

    @property
    def recall(self) -> float:
        if self.tp + self.fn == 0:
            return 0.0
        return self.tp / (self.tp + self.fn)

    @property
    def f1_score(self) -> float:
        if self.precision + self.recall == 0:
            return 0.0
        return 2 * self.precision * self.recall / (self.precision + self.recall)

    @property
    def accuracy(self) -> float:
        total = self.tp + self.fp + self.fn + self.tn
        if total == 0:
            return 0.0
        return (self.tp + self.tn) / total


def load_test_data(data_path: str) -> List[Dict]:
    """加载测试数据集"""
    path = Path(data_path)
    if not path.exists():
        print(f"错误: 测试数据文件不存在: {data_path}")
        sys.exit(1)

    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def run_alarm_detection(sample: Dict) -> bool:
    """
    模拟边缘报警引擎检测
    实际应通过串口或 RPC 调用设备端检测
    """
    heart_rate = sample.get('heart_rate', 0)
    respiration_rate = sample.get('respiration_rate', 0)
    spo2 = sample.get('spo2', 100)

    # 简化检测逻辑
    if respiration_rate > 0 and respiration_rate < 10:
        return True  # 呼吸暂停
    if heart_rate > 100:
        return True  # 心动过速
    if heart_rate > 0 and heart_rate < 40:
        return True  # 心动过缓
    if spo2 > 0 and spo2 < 90:
        return True  # 血氧异常

    return False


def evaluate(test_data: List[Dict]) -> Dict[str, ConfusionMatrix]:
    """评估报警准确率"""
    matrices: Dict[str, ConfusionMatrix] = {}
    overall = ConfusionMatrix()

    for sample in test_data:
        alarm_type = sample.get('alarm_type', 'unknown')
        ground_truth = sample.get('label', False)
        prediction = run_alarm_detection(sample)

        if alarm_type not in matrices:
            matrices[alarm_type] = ConfusionMatrix()

        cm = matrices[alarm_type]

        if ground_truth and prediction:
            cm.tp += 1
            overall.tp += 1
        elif not ground_truth and prediction:
            cm.fp += 1
            overall.fp += 1
        elif ground_truth and not prediction:
            cm.fn += 1
            overall.fn += 1
        else:
            cm.tn += 1
            overall.tn += 1

    matrices['overall'] = overall
    return matrices


def print_report(matrices: Dict[str, ConfusionMatrix]):
    """打印测试报告"""
    print("\n" + "=" * 70)
    print("报警准确率测试报告")
    print("=" * 70)

    for alarm_type, cm in matrices.items():
        print(f"\n[{alarm_type}]")
        print(f"  TP: {cm.tp:4d}  FP: {cm.fp:4d}")
        print(f"  FN: {cm.fn:4d}  TN: {cm.tn:4d}")
        print(f"  精确率: {cm.precision:.4f}")
        print(f"  召回率: {cm.recall:.4f}")
        print(f"  F1 分数: {cm.f1_score:.4f}")
        print(f"  准确率: {cm.accuracy:.4f}")

    # 验收阈值检查
    overall = matrices.get('overall', ConfusionMatrix())
    print("\n" + "-" * 70)
    print("验收阈值检查")
    print("-" * 70)

    thresholds = {
        '精确率': (overall.precision, 0.90),
        '召回率': (overall.recall, 0.85),
        'F1 分数': (overall.f1_score, 0.87),
    }

    all_passed = True
    for name, (value, threshold) in thresholds.items():
        passed = value >= threshold
        status = "✅ 通过" if passed else "❌ 未通过"
        print(f"  {name}: {value:.4f} (阈值: {threshold:.2f}) {status}")
        if not passed:
            all_passed = False

    print("\n" + "=" * 70)
    if all_passed:
        print("总体结果: ✅ 验收通过")
    else:
        print("总体结果: ❌ 验收未通过")
    print("=" * 70)

    return all_passed


def main():
    parser = argparse.ArgumentParser(description='报警准确率测试')
    parser.add_argument('--data', required=True, help='测试数据集 JSON 文件')
    parser.add_argument('--output', help='输出报告 JSON 文件')
    args = parser.parse_args()

    print("加载测试数据...")
    test_data = load_test_data(args.data)
    print(f"测试样本数: {len(test_data)}")

    print("执行报警检测...")
    matrices = evaluate(test_data)

    passed = print_report(matrices)

    if args.output:
        report = {
            alarm_type: {
                'tp': cm.tp, 'fp': cm.fp, 'fn': cm.fn, 'tn': cm.tn,
                'precision': cm.precision, 'recall': cm.recall,
                'f1_score': cm.f1_score, 'accuracy': cm.accuracy,
            }
            for alarm_type, cm in matrices.items()
        }
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"\n报告已保存: {args.output}")

    sys.exit(0 if passed else 1)


if __name__ == '__main__':
    main()
