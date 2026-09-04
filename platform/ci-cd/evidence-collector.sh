#!/bin/bash
# 证据收集脚本
#
# 在部署完成后自动收集验收证据，包括：
# - 部署版本信息
# - 服务健康状态
# - 性能指标
# - 安全扫描结果
# - 测试报告

set -euo pipefail

# 配置
ENVIRONMENT="${1:-production}"
OUTPUT_DIR="${2:-evidence}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
EVIDENCE_DIR="${OUTPUT_DIR}/${ENVIRONMENT}-${TIMESTAMP}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 创建证据目录
mkdir -p "${EVIDENCE_DIR}"

log_info "开始收集 ${ENVIRONMENT} 环境验收证据"
log_info "证据目录: ${EVIDENCE_DIR}"

# ============================================================
# 1. 部署版本信息
# ============================================================
log_info "收集部署版本信息..."

cat > "${EVIDENCE_DIR}/deployment-info.json" <<EOF
{
  "environment": "${ENVIRONMENT}",
  "timestamp": "$(date -Iseconds)",
  "git_commit": "${CI_COMMIT_SHA:-unknown}",
  "git_branch": "${CI_COMMIT_BRANCH:-unknown}",
  "pipeline_id": "${CI_PIPELINE_ID:-unknown}",
  "deployer": "${GITLAB_USER_EMAIL:-unknown}"
}
EOF

# 获取所有 Deployment 的镜像版本
kubectl get deployments -A -o jsonpath='{range .items[*]}{.metadata.namespace}{","}{.metadata.name}{","}{.spec.template.spec.containers[*].image}{"\n"}{end}' \
  > "${EVIDENCE_DIR}/deployment-images.csv" 2>/dev/null || log_warn "无法获取部署镜像信息"

# ============================================================
# 2. 服务健康状态
# ============================================================
log_info "收集服务健康状态..."

# 节点状态
kubectl get nodes -o wide > "${EVIDENCE_DIR}/nodes-status.txt" 2>/dev/null || true

# Pod 状态
kubectl get pods -A -o wide > "${EVIDENCE_DIR}/pods-status.txt" 2>/dev/null || true

# 不健康的 Pod
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded \
  > "${EVIDENCE_DIR}/unhealthy-pods.txt" 2>/dev/null || true

# 服务列表
kubectl get svc -A > "${EVIDENCE_DIR}/services.txt" 2>/dev/null || true

# Ingress 列表
kubectl get ingress -A > "${EVIDENCE_DIR}/ingresses.txt" 2>/dev/null || true

# ============================================================
# 3. 健康检查
# ============================================================
log_info "执行健康检查..."

HEALTH_CHECK_FILE="${EVIDENCE_DIR}/health-checks.json"
echo "{" > "${HEALTH_CHECK_FILE}"
echo "  \"checks\": [" >> "${HEALTH_CHECK_FILE}"

# 检查后端 API
BACKEND_URL="https://api.sleep-monitor.com/health"
if curl -sf "${BACKEND_URL}" > /dev/null 2>&1; then
  echo "    {\"name\": \"backend-api\", \"status\": \"healthy\", \"url\": \"${BACKEND_URL}\"}," >> "${HEALTH_CHECK_FILE}"
  log_info "  后端 API: 健康"
else
  echo "    {\"name\": \"backend-api\", \"status\": \"unhealthy\", \"url\": \"${BACKEND_URL}\"}," >> "${HEALTH_CHECK_FILE}"
  log_warn "  后端 API: 不健康"
fi

# 检查 MQTT Broker
if kubectl exec -n iot deploy/emqx -- emqx_ctl status > /dev/null 2>&1; then
  echo "    {\"name\": \"emqx-broker\", \"status\": \"healthy\"}" >> "${HEALTH_CHECK_FILE}"
  log_info "  EMQX Broker: 健康"
else
  echo "    {\"name\": \"emqx-broker\", \"status\": \"unhealthy\"}" >> "${HEALTH_CHECK_FILE}"
  log_warn "  EMQX Broker: 不健康"
fi

echo "  ]" >> "${HEALTH_CHECK_FILE}"
echo "}" >> "${HEALTH_CHECK_FILE}"

# ============================================================
# 4. 资源使用情况
# ============================================================
log_info "收集资源使用情况..."

kubectl top nodes > "${EVIDENCE_DIR}/node-usage.txt" 2>/dev/null || log_warn "metrics-server 不可用"
kubectl top pods -A > "${EVIDENCE_DIR}/pod-usage.txt" 2>/dev/null || true

# ============================================================
# 5. 安全状态
# ============================================================
log_info "收集安全状态..."

# RBAC 角色
kubectl get clusterroles > "${EVIDENCE_DIR}/cluster-roles.txt" 2>/dev/null || true
kubectl get clusterrolebindings > "${EVIDENCE_DIR}/cluster-role-bindings.txt" 2>/dev/null || true

# Secret 数量
kubectl get secrets -A --no-headers | wc -l > "${EVIDENCE_DIR}/secret-count.txt" 2>/dev/null || true

# ============================================================
# 6. 生成总结报告
# ============================================================
log_info "生成总结报告..."

SUMMARY_FILE="${EVIDENCE_DIR}/summary.md"
cat > "${SUMMARY_FILE}" <<EOF
# ${ENVIRONMENT} 环境验收证据报告

**生成时间**: $(date -Iseconds)
**Git Commit**: ${CI_COMMIT_SHA:-unknown}
**部署人**: ${GITLAB_USER_EMAIL:-unknown}

## 1. 部署信息

- 环境: ${ENVIRONMENT}
- 部署时间: $(date -Iseconds)
- 流水线 ID: ${CI_PIPELINE_ID:-unknown}

## 2. 服务健康状态

详见 \`health-checks.json\`

## 3. 资源使用

详见 \`node-usage.txt\` 和 \`pod-usage.txt\`

## 4. 证据清单

EOF

ls -la "${EVIDENCE_DIR}/" | tail -n +2 | awk '{print "- " $9 " (" $5 " bytes)"}' >> "${SUMMARY_FILE}"

log_info "证据收集完成"
log_info "证据目录: ${EVIDENCE_DIR}"
log_info "总结报告: ${SUMMARY_FILE}"

# 输出证据目录路径（供 CI  artifact 使用）
echo "EVIDENCE_DIR=${EVIDENCE_DIR}"
