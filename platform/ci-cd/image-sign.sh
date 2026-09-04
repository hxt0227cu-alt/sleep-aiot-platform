#!/bin/bash
# 容器镜像签名脚本
#
# 使用 Cosign 对容器镜像进行签名，确保镜像完整性和来源可信。

set -euo pipefail

# 配置
REGISTRY="${REGISTRY:-registry.cn-shenzhen.aliyuncs.com}"
IMAGE_NAME="${1:?用法: image-sign.sh <image-name> [tag]}"
IMAGE_TAG="${2:-latest}"
COSIGN_KEY="${COSIGN_KEY:-cosign.key}"
COSIGN_PASSWORD="${COSIGN_PASSWORD:-}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "=========================================="
echo "  容器镜像签名"
echo "=========================================="
echo "镜像: ${FULL_IMAGE}"
echo ""

# ============================================================
# 1. 检查 Cosign 是否安装
# ============================================================
if ! command -v cosign &> /dev/null; then
  log_error "Cosign 未安装"
  echo "安装方法:"
  echo "  go install github.com/sigstore/cosign/v2/cmd/cosign@latest"
  echo "  或从 https://github.com/sigstore/cosign/releases 下载"
  exit 1
fi

log_info "Cosign 版本: $(cosign version 2>&1 | head -1)"

# ============================================================
# 2. 检查镜像是否存在
# ============================================================
log_info "检查镜像是否存在..."

if ! docker manifest inspect "${FULL_IMAGE}" > /dev/null 2>&1; then
  log_error "镜像不存在: ${FULL_IMAGE}"
  exit 1
fi

log_info "镜像存在"

# ============================================================
# 3. 检查签名密钥
# ============================================================
if [ ! -f "${COSIGN_KEY}" ]; then
  log_warn "签名密钥不存在，生成新密钥对..."

  if [ -z "${COSIGN_PASSWORD}" ]; then
    log_error "需要设置 COSIGN_PASSWORD 环境变量"
    exit 1
  fi

  COSIGN_PASSWORD="${COSIGN_PASSWORD}" cosign generate-key-pair

  log_info "密钥对已生成:"
  echo "  私钥: ${COSIGN_KEY}"
  echo "  公钥: ${COSIGN_KEY%.key}.pub"
fi

# ============================================================
# 4. 签名镜像
# ============================================================
log_info "开始签名镜像..."

if [ -n "${COSIGN_PASSWORD}" ]; then
  COSIGN_PASSWORD="${COSIGN_PASSWORD}" cosign sign --key "${COSIGN_KEY}" "${FULL_IMAGE}" --yes
else
  cosign sign --key "${COSIGN_KEY}" "${FULL_IMAGE}" --yes
fi

log_info "镜像签名完成"

# ============================================================
# 5. 验证签名
# ============================================================
log_info "验证镜像签名..."

PUB_KEY="${COSIGN_KEY%.key}.pub"

if cosign verify --key "${PUB_KEY}" "${FULL_IMAGE}" > /dev/null 2>&1; then
  log_info "签名验证通过"
else
  log_error "签名验证失败"
  exit 1
fi

# ============================================================
# 6. 输出签名信息
# ============================================================
echo ""
echo "=========================================="
echo "  签名信息"
echo "=========================================="
echo "镜像: ${FULL_IMAGE}"
echo "公钥: ${PUB_KEY}"
echo ""

cosign verify --key "${PUB_KEY}" "${FULL_IMAGE}" 2>&1 | jq '.[0].critical' 2>/dev/null || true

echo ""
echo -e "${GREEN}镜像签名和验证完成！${NC}"
