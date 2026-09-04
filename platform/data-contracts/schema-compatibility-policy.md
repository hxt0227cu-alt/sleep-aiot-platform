# Schema 兼容性策略

## 概述

本文档定义平台所有数据契约（Schema）的版本管理和兼容性策略，确保前后端、设备端、服务间的接口变更不会导致不兼容。

## 兼容性原则

### 向后兼容（Backward Compatible）

**定义**: 新版本的 Schema 可以读取旧版本的数据，旧版本的客户端可以使用新版本的服务。

**允许的变更**:
- 添加可选字段（有默认值）
- 添加新的枚举值
- 放宽字段约束（如最大长度增加）
- 添加新的 API 端点
- 弃用字段（标记为 deprecated，但仍保留）

**不允许的变更**:
- 删除必填字段
- 修改字段类型
- 修改字段名称
- 收紧字段约束（如最大长度减少）
- 删除枚举值
- 修改字段语义

### 向前兼容（Forward Compatible）

**定义**: 旧版本的 Schema 可以读取新版本的数据（忽略未知字段）。

**要求**:
- 所有客户端必须忽略未知字段
- 所有序列化格式必须支持未知字段保留
- 新增字段必须有默认值

## 版本管理策略

### 版本号格式

```
<major>.<minor>.<patch>
```

- **major**: 不兼容的变更（Breaking Change）
- **minor**: 向后兼容的功能新增
- **patch**: 向后兼容的修复

### 版本升级规则

| 变更类型 | 版本号变化 | 示例 |
|---------|-----------|------|
| 添加可选字段 | minor +1 | 1.2.0 → 1.3.0 |
| 添加新枚举值 | minor +1 | 1.2.0 → 1.3.0 |
| 修复字段约束错误 | patch +1 | 1.2.0 → 1.2.1 |
| 删除字段 | major +1 | 1.2.0 → 2.0.0 |
| 修改字段类型 | major +1 | 1.2.0 → 2.0.0 |
| 修改字段语义 | major +1 | 1.2.0 → 2.0.0 |

## 变更流程

### 1. 变更提案

- 创建变更提案（Change Proposal）
- 描述变更内容、原因、影响范围
- 评估兼容性影响
- 确定版本号

### 2. 兼容性检查

**自动化检查**:
```bash
# 使用 Schema 兼容性检查工具
# 例如: buf breaking (Protobuf), spectral (OpenAPI)

# Protobuf 兼容性检查
buf breaking --against '.git#branch=main'

# OpenAPI 兼容性检查
spectral lint openapi.yaml --ruleset compatibility
```

**人工检查**:
- 字段语义是否变化
- 业务逻辑是否受影响
- 设备端是否需要升级
- 数据迁移是否需要

### 3. 变更审批

| 变更类型 | 审批人 | 审批时间 |
|---------|--------|---------|
| patch 变更 | 技术负责人 | 1工作日 |
| minor 变更 | 技术负责人 + 架构师 | 2工作日 |
| major 变更 | 架构师 + 工程经理 | 5工作日 |

### 4. 变更实施

**minor/patch 变更**:
1. 更新 Schema 定义
2. 更新服务端实现（先支持新版本）
3. 更新客户端实现（后升级客户端）
4. 更新文档
5. 发布新版本

**major 变更（不兼容）**:
1. 创建新版本 Schema（v2）
2. 服务端同时支持 v1 和 v2
3. 客户端逐步迁移到 v2
4. 监控 v1 使用量
5. 当 v1 使用量为 0 时，移除 v1 支持
6. 整个过程至少持续 3 个月

## 弃用策略

### 字段弃用

**弃用流程**:
1. 标记字段为 `deprecated: true`
2. 添加弃用说明和替代方案
3. 服务端继续支持该字段（至少 3 个版本）
4. 客户端收到弃用警告后迁移
5. 监控字段使用量
6. 使用量为 0 后，在下一个 major 版本中删除

**示例**:
```json
{
  "oldField": {
    "type": "string",
    "deprecated": true,
    "deprecationReason": "Use newField instead",
    "deprecationVersion": "1.3.0",
    "removalVersion": "2.0.0"
  },
  "newField": {
    "type": "string",
    "description": "Replacement for oldField"
  }
}
```

### API 端点弃用

**弃用流程**:
1. 在响应头中添加 `Deprecation` 和 `Sunset` 头
2. 在文档中标记弃用
3. 继续支持至少 6 个月
4. 监控端点使用量
5. 使用量为 0 后移除

**示例**:
```
Deprecation: true
Sunset: Wed, 31 Dec 2026 23:59:59 GMT
Link: <https://api.sleep-monitor.com/v2/resource>; rel="successor-version"
```

## 设备端特殊策略

### 设备端约束

- 设备固件更新周期长（部分设备可能永远不更新）
- 设备内存和存储有限
- 设备网络不稳定

### 设备端兼容性要求

1. **服务端必须支持所有已发布的设备固件版本**
   - 至少支持最近 2 年的固件版本
   - 不兼容变更需要设备端升级才能使用新功能

2. **设备端必须忽略未知字段**
   - 所有解析器必须配置为忽略未知字段
   - 未知字段不影响已有功能

3. **新增功能需要设备端能力协商**
   - 设备上报支持的功能列表
   - 服务端根据设备能力下发对应参数
   - 不支持新功能的设备继续使用旧参数

### 设备端参数包兼容性

**算法参数包**:
- 参数包版本与固件版本绑定
- 服务端根据设备固件版本选择对应版本的参数包
- 不兼容的参数变更需要新的参数包版本
- 设备端校验参数范围，超出范围使用默认值

## 数据库 Schema 兼容性

### 迁移策略

**Expand-Contract 模式**:
1. **Expand 阶段**: 添加新字段/表，不修改旧字段
2. **迁移阶段**: 数据迁移，双写新旧字段
3. **Contract 阶段**: 移除旧字段（需要确认无使用）

**示例**:
```sql
-- Expand: 添加新字段
ALTER TABLE users ADD COLUMN phone_encrypted VARCHAR(256);

-- 迁移: 双写
-- 应用层同时写入 phone 和 phone_encrypted

-- 数据回填
UPDATE users SET phone_encrypted = encrypt(phone) WHERE phone_encrypted IS NULL;

-- Contract: 移除旧字段（确认无使用后）
ALTER TABLE users DROP COLUMN phone;
```

### 迁移验证

1. 迁移前备份数据库
2. 在测试环境验证迁移脚本
3. 生产环境先在从库验证
4. 迁移后验证数据完整性
5. 迁移后监控应用错误率

## 消息队列 Schema 兼容性

### Kafka 消息 Schema

- 使用 Schema Registry 管理 Avro/Protobuf Schema
- 兼容性策略设置为 `BACKWARD`（默认）
- 新版本 Schema 必须能读取旧版本消息
- 消费者必须能处理未知字段

### 兼容性检查

```bash
# 检查 Schema 兼容性
curl -X POST http://schema-registry:8081/compatibility/subjects/topic-value/versions \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{...}"}'
```

## 兼容性测试

### 自动化测试

1. **Schema 兼容性测试**: CI/CD 中自动检查
2. **契约测试**: 消费者驱动契约测试（Pact）
3. **集成测试**: 多版本客户端与服务端集成测试
4. **回归测试**: 旧版本功能回归测试

### 测试矩阵

| 服务端版本 | 客户端版本 | 测试要求 |
|-----------|-----------|---------|
| 最新 | 最新 | 必须通过 |
| 最新 | 上一个 minor | 必须通过 |
| 最新 | 上一个 major | 必须通过（如仍支持） |
| 上一个 minor | 最新 | 必须通过（向前兼容） |

## 相关文档

- [算法参数包 Schema](./algorithm-param-package.v1.schema.json)
- [API 设计规范](../../docs/api-design-guide.md)
- [数据库迁移规范](../../backend/prisma/migrations/README.md)
- [设备固件兼容性](../../firmware/docs/firmware-compatibility.md)
