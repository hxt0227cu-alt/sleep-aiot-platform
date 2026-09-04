"""
A/B 测试服务

功能：
  1. 管理 A/B 测试实验
  2. 用户分桶（确定性哈希分桶）
  3. 实验数据收集和统计
  4. 实验结果分析（显著性检验）
  5. 实验生命周期管理

使用：
  from app.ab_testing import ABTestingService
  ab_service = ABTestingService()
  variant = ab_service.get_variant(user_id='user_123', experiment_id='exp_alarm_threshold')
"""

import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Dict, List, Optional, Tuple
from uuid import uuid4


class ExperimentStatus(Enum):
    """实验状态"""
    DRAFT = "draft"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class VariantType(Enum):
    """变体类型"""
    CONTROL = "control"
    TREATMENT = "treatment"


@dataclass
class Variant:
    """实验变体"""
    id: str
    name: str
    type: VariantType
    weight: float = 0.5  # 流量权重 0-1
    config: Dict = field(default_factory=dict)
    user_count: int = 0
    conversion_count: int = 0


@dataclass
class Experiment:
    """A/B 测试实验"""
    id: str
    name: str
    description: str
    status: ExperimentStatus
    variants: List[Variant]
    target_metric: str  # 目标指标名称
    min_sample_size: int = 1000
    confidence_level: float = 0.95
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)
    metadata: Dict = field(default_factory=dict)


@dataclass
class ExperimentResult:
    """实验结果"""
    experiment_id: str
    control_variant: Variant
    treatment_variant: Variant
    control_conversion_rate: float
    treatment_conversion_rate: float
    absolute_lift: float
    relative_lift: float
    p_value: float
    is_significant: bool
    confidence_interval: Tuple[float, float]
    recommendation: str
    analyzed_at: datetime


class ABTestingService:
    """A/B 测试服务"""

    def __init__(self, storage_path: Optional[str] = None):
        self.storage_path = storage_path or os.environ.get(
            'AB_TEST_STORAGE_PATH', '/data/ab-tests.json'
        )
        self.experiments: Dict[str, Experiment] = {}
        self.user_assignments: Dict[str, Dict[str, str]] = {}  # user_id -> {exp_id -> variant_id}
        self._load()

    def _load(self) -> None:
        """加载实验数据"""
        try:
            if os.path.exists(self.storage_path):
                with open(self.storage_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    for exp_data in data.get('experiments', []):
                        exp = self._deserialize_experiment(exp_data)
                        self.experiments[exp.id] = exp
                    self.user_assignments = data.get('user_assignments', {})
        except Exception as e:
            print(f"[WARNING] 加载 A/B 测试数据失败: {e}", file=sys.stderr)

    def _save(self) -> None:
        """保存实验数据"""
        try:
            os.makedirs(os.path.dirname(self.storage_path), exist_ok=True)
            data = {
                'experiments': [self._serialize_experiment(exp) for exp in self.experiments.values()],
                'user_assignments': self.user_assignments,
                'last_updated': datetime.now().isoformat(),
            }
            with open(self.storage_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[ERROR] 保存 A/B 测试数据失败: {e}", file=sys.stderr)

    def _serialize_experiment(self, exp: Experiment) -> Dict:
        """序列化实验"""
        return {
            'id': exp.id,
            'name': exp.name,
            'description': exp.description,
            'status': exp.status.value,
            'variants': [
                {
                    'id': v.id,
                    'name': v.name,
                    'type': v.type.value,
                    'weight': v.weight,
                    'config': v.config,
                    'user_count': v.user_count,
                    'conversion_count': v.conversion_count,
                }
                for v in exp.variants
            ],
            'target_metric': exp.target_metric,
            'min_sample_size': exp.min_sample_size,
            'confidence_level': exp.confidence_level,
            'start_time': exp.start_time.isoformat() if exp.start_time else None,
            'end_time': exp.end_time.isoformat() if exp.end_time else None,
            'created_at': exp.created_at.isoformat(),
            'updated_at': exp.updated_at.isoformat(),
            'metadata': exp.metadata,
        }

    def _deserialize_experiment(self, data: Dict) -> Experiment:
        """反序列化实验"""
        variants = [
            Variant(
                id=v['id'],
                name=v['name'],
                type=VariantType(v['type']),
                weight=v.get('weight', 0.5),
                config=v.get('config', {}),
                user_count=v.get('user_count', 0),
                conversion_count=v.get('conversion_count', 0),
            )
            for v in data['variants']
        ]
        return Experiment(
            id=data['id'],
            name=data['name'],
            description=data.get('description', ''),
            status=ExperimentStatus(data['status']),
            variants=variants,
            target_metric=data['target_metric'],
            min_sample_size=data.get('min_sample_size', 1000),
            confidence_level=data.get('confidence_level', 0.95),
            start_time=datetime.fromisoformat(data['start_time']) if data.get('start_time') else None,
            end_time=datetime.fromisoformat(data['end_time']) if data.get('end_time') else None,
            created_at=datetime.fromisoformat(data['created_at']),
            updated_at=datetime.fromisoformat(data['updated_at']),
            metadata=data.get('metadata', {}),
        )

    def _hash_user_to_bucket(self, user_id: str, experiment_id: str) -> float:
        """
        确定性哈希分桶

        使用用户 ID 和实验 ID 组合进行哈希，确保：
        1. 同一用户在同一实验中始终分到同一组
        2. 不同实验之间独立分桶
        3. 分桶结果均匀分布
        """
        key = f"{user_id}:{experiment_id}"
        hash_bytes = hashlib.sha256(key.encode('utf-8')).digest()
        # 取前 8 字节作为整数，归一化到 0-1
        hash_int = int.from_bytes(hash_bytes[:8], byteorder='big')
        return hash_int / (2 ** 64)

    def create_experiment(
        self,
        name: str,
        description: str,
        target_metric: str,
        control_config: Dict,
        treatment_config: Dict,
        control_weight: float = 0.5,
        treatment_weight: float = 0.5,
        min_sample_size: int = 1000,
        confidence_level: float = 0.95,
    ) -> Experiment:
        """创建新实验"""
        exp_id = f"exp_{uuid4().hex[:8]}"
        control_variant = Variant(
            id=f"{exp_id}_control",
            name="对照组",
            type=VariantType.CONTROL,
            weight=control_weight,
            config=control_config,
        )
        treatment_variant = Variant(
            id=f"{exp_id}_treatment",
            name="实验组",
            type=VariantType.TREATMENT,
            weight=treatment_weight,
            config=treatment_config,
        )
        experiment = Experiment(
            id=exp_id,
            name=name,
            description=description,
            status=ExperimentStatus.DRAFT,
            variants=[control_variant, treatment_variant],
            target_metric=target_metric,
            min_sample_size=min_sample_size,
            confidence_level=confidence_level,
        )
        self.experiments[exp_id] = experiment
        self._save()
        return experiment

    def start_experiment(self, experiment_id: str) -> bool:
        """启动实验"""
        if experiment_id not in self.experiments:
            return False
        exp = self.experiments[experiment_id]
        if exp.status != ExperimentStatus.DRAFT:
            return False
        exp.status = ExperimentStatus.RUNNING
        exp.start_time = datetime.now()
        exp.updated_at = datetime.now()
        self._save()
        return True

    def pause_experiment(self, experiment_id: str) -> bool:
        """暂停实验"""
        if experiment_id not in self.experiments:
            return False
        exp = self.experiments[experiment_id]
        if exp.status != ExperimentStatus.RUNNING:
            return False
        exp.status = ExperimentStatus.PAUSED
        exp.updated_at = datetime.now()
        self._save()
        return True

    def complete_experiment(self, experiment_id: str) -> Optional[ExperimentResult]:
        """完成实验并分析结果"""
        if experiment_id not in self.experiments:
            return None
        exp = self.experiments[experiment_id]
        if exp.status not in (ExperimentStatus.RUNNING, ExperimentStatus.PAUSED):
            return None

        result = self.analyze_experiment(experiment_id)
        if result:
            exp.status = ExperimentStatus.COMPLETED
            exp.end_time = datetime.now()
            exp.updated_at = datetime.now()
            exp.metadata['final_result'] = {
                'p_value': result.p_value,
                'is_significant': result.is_significant,
                'recommendation': result.recommendation,
            }
            self._save()
        return result

    def get_variant(self, user_id: str, experiment_id: str) -> Optional[Variant]:
        """
        获取用户在实验中的变体

        分桶逻辑：
        1. 检查是否已有分配（确保一致性）
        2. 使用确定性哈希计算分桶位置
        3. 根据变体权重分配到对应变体
        4. 记录分配结果
        """
        if experiment_id not in self.experiments:
            return None

        exp = self.experiments[experiment_id]
        if exp.status != ExperimentStatus.RUNNING:
            return None

        # 检查已有分配
        if user_id in self.user_assignments:
            user_exps = self.user_assignments[user_id]
            if experiment_id in user_exps:
                variant_id = user_exps[experiment_id]
                for v in exp.variants:
                    if v.id == variant_id:
                        return v

        # 计算分桶
        bucket = self._hash_user_to_bucket(user_id, experiment_id)

        # 根据权重分配
        cumulative_weight = 0.0
        assigned_variant = None
        for v in exp.variants:
            cumulative_weight += v.weight
            if bucket < cumulative_weight:
                assigned_variant = v
                break

        if assigned_variant is None:
            assigned_variant = exp.variants[-1]

        # 记录分配
        if user_id not in self.user_assignments:
            self.user_assignments[user_id] = {}
        self.user_assignments[user_id][experiment_id] = assigned_variant.id

        # 更新变体用户计数
        assigned_variant.user_count += 1
        exp.updated_at = datetime.now()
        self._save()

        return assigned_variant

    def record_conversion(self, user_id: str, experiment_id: str, metric: str) -> bool:
        """记录转化事件"""
        if experiment_id not in self.experiments:
            return False

        exp = self.experiments[experiment_id]
        if exp.target_metric != metric:
            return False

        # 查找用户分配的变体
        if user_id not in self.user_assignments or experiment_id not in self.user_assignments[user_id]:
            return False

        variant_id = self.user_assignments[user_id][experiment_id]
        for v in exp.variants:
            if v.id == variant_id:
                v.conversion_count += 1
                exp.updated_at = datetime.now()
                self._save()
                return True

        return False

    def _calculate_p_value(
        self,
        control_users: int,
        control_conversions: int,
        treatment_users: int,
        treatment_conversions: int,
    ) -> float:
        """
        计算双比例 Z 检验的 p 值

        使用正态近似计算两个比例差异的显著性。
        """
        if control_users == 0 or treatment_users == 0:
            return 1.0

        p1 = control_conversions / control_users
        p2 = treatment_conversions / treatment_users

        # 合并比例
        p_pool = (control_conversions + treatment_conversions) / (control_users + treatment_users)

        # 标准误
        se = math.sqrt(p_pool * (1 - p_pool) * (1 / control_users + 1 / treatment_users))

        if se == 0:
            return 1.0

        # Z 统计量
        z = (p2 - p1) / se

        # 双尾 p 值（使用误差函数近似）
        p_value = self._normal_cdf(-abs(z)) * 2

        return p_value

    def _normal_cdf(self, x: float) -> float:
        """标准正态分布累积分布函数（近似）"""
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))

    def _calculate_confidence_interval(
        self,
        control_users: int,
        control_conversions: int,
        treatment_users: int,
        treatment_conversions: int,
        confidence_level: float = 0.95,
    ) -> Tuple[float, float]:
        """计算转化率差异的置信区间"""
        if control_users == 0 or treatment_users == 0:
            return (0.0, 0.0)

        p1 = control_conversions / control_users
        p2 = treatment_conversions / treatment_users
        diff = p2 - p1

        # 标准误（不合并）
        se = math.sqrt(
            p1 * (1 - p1) / control_users +
            p2 * (1 - p2) / treatment_users
        )

        # Z 值（95% 置信度对应 1.96）
        z = 1.96 if confidence_level == 0.95 else 1.645

        margin = z * se
        return (diff - margin, diff + margin)

    def analyze_experiment(self, experiment_id: str) -> Optional[ExperimentResult]:
        """分析实验结果"""
        if experiment_id not in self.experiments:
            return None

        exp = self.experiments[experiment_id]

        control_variant = None
        treatment_variant = None
        for v in exp.variants:
            if v.type == VariantType.CONTROL:
                control_variant = v
            elif v.type == VariantType.TREATMENT:
                treatment_variant = v

        if not control_variant or not treatment_variant:
            return None

        control_rate = (
            control_variant.conversion_count / control_variant.user_count
            if control_variant.user_count > 0 else 0
        )
        treatment_rate = (
            treatment_variant.conversion_count / treatment_variant.user_count
            if treatment_variant.user_count > 0 else 0
        )

        absolute_lift = treatment_rate - control_rate
        relative_lift = (
            (treatment_rate - control_rate) / control_rate
            if control_rate > 0 else 0
        )

        p_value = self._calculate_p_value(
            control_variant.user_count,
            control_variant.conversion_count,
            treatment_variant.user_count,
            treatment_variant.conversion_count,
        )

        is_significant = p_value < (1 - exp.confidence_level)

        ci = self._calculate_confidence_interval(
            control_variant.user_count,
            control_variant.conversion_count,
            treatment_variant.user_count,
            treatment_variant.conversion_count,
            exp.confidence_level,
        )

        # 生成建议
        total_users = control_variant.user_count + treatment_variant.user_count
        if total_users < exp.min_sample_size:
            recommendation = f"样本量不足（当前 {total_users}，需要 {exp.min_sample_size}），建议继续实验"
        elif is_significant and absolute_lift > 0:
            recommendation = f"实验组显著优于对照组（提升 {relative_lift*100:.1f}%），建议全量发布实验组方案"
        elif is_significant and absolute_lift < 0:
            recommendation = f"实验组显著差于对照组（下降 {abs(relative_lift)*100:.1f}%），建议保留对照组方案"
        else:
            recommendation = "无显著差异，建议继续实验或选择成本更低的方案"

        return ExperimentResult(
            experiment_id=exp.id,
            control_variant=control_variant,
            treatment_variant=treatment_variant,
            control_conversion_rate=control_rate,
            treatment_conversion_rate=treatment_rate,
            absolute_lift=absolute_lift,
            relative_lift=relative_lift,
            p_value=p_value,
            is_significant=is_significant,
            confidence_interval=ci,
            recommendation=recommendation,
            analyzed_at=datetime.now(),
        )

    def list_experiments(self, status: Optional[ExperimentStatus] = None) -> List[Experiment]:
        """列出实验"""
        experiments = list(self.experiments.values())
        if status:
            experiments = [e for e in experiments if e.status == status]
        return sorted(experiments, key=lambda e: e.created_at, reverse=True)

    def get_experiment(self, experiment_id: str) -> Optional[Experiment]:
        """获取实验详情"""
        return self.experiments.get(experiment_id)


# 示例用法
if __name__ == "__main__":
    # 创建服务
    service = ABTestingService(storage_path="/tmp/ab-test-demo.json")

    # 创建实验
    exp = service.create_experiment(
        name="报警阈值优化实验",
        description="测试新的报警阈值是否能降低误报率",
        target_metric="alarm_accuracy",
        control_config={"apnea_threshold": 10, "tachycardia_threshold": 100},
        treatment_config={"apnea_threshold": 12, "tachycardia_threshold": 105},
        min_sample_size=500,
    )
    print(f"创建实验: {exp.id} - {exp.name}")

    # 启动实验
    service.start_experiment(exp.id)
    print(f"启动实验: {exp.status.value}")

    # 模拟用户分桶和转化
    for i in range(100):
        user_id = f"user_{i}"
        variant = service.get_variant(user_id, exp.id)
        if variant:
            # 模拟 30% 的转化率
            import random
            if random.random() < 0.3:
                service.record_conversion(user_id, exp.id, "alarm_accuracy")

    # 分析结果
    result = service.analyze_experiment(exp.id)
    if result:
        print(f"\n实验结果分析:")
        print(f"  对照组转化率: {result.control_conversion_rate*100:.1f}%")
        print(f"  实验组转化率: {result.treatment_conversion_rate*100:.1f}%")
        print(f"  绝对提升: {result.absolute_lift*100:.1f}%")
        print(f"  相对提升: {result.relative_lift*100:.1f}%")
        print(f"  P 值: {result.p_value:.4f}")
        print(f"  显著: {result.is_significant}")
        print(f"  建议: {result.recommendation}")
