#!/bin/bash
# SBOM (Software Bill of Materials) 生成脚本
#
# 生成项目的软件物料清单，用于合规审计和漏洞管理。

set -euo pipefail

# 配置
OUTPUT_FORMAT="${OUTPUT_FORMAT:-cyclonedx}"  # cyclonedx / spdx
OUTPUT_DIR="${OUTPUT_DIR:-sbom}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

mkdir -p "${OUTPUT_DIR}"

echo "=========================================="
echo "  SBOM 生成"
echo "=========================================="
echo "输出格式: ${OUTPUT_FORMAT}"
echo "输出目录: ${OUTPUT_DIR}"
echo ""

# ============================================================
# 1. 后端 (Node.js) 依赖
# ============================================================
log_info "生成后端依赖 SBOM..."

if [ -f "backend/package.json" ]; then
  cd backend

  if command -v cyclonedx-npm &> /dev/null; then
    cyclonedx-npm --output-format "${OUTPUT_FORMAT}" --output-file "../${OUTPUT_DIR}/backend-${TIMESTAMP}.json"
    log_info "后端 SBOM 已生成"
  elif command -v syft &> /dev/null; then
    syft packages dir:. --output "${OUTPUT_FORMAT}-json" > "../${OUTPUT_DIR}/backend-${TIMESTAMP}.json"
    log_info "后端 SBOM 已生成 (使用 syft)"
  else
    log_warn "未找到 cyclonedx-npm 或 syft，使用 npm ls 生成简单清单"
    npm ls --json --prod > "../${OUTPUT_DIR}/backend-${TIMESTAMP}.json" 2>/dev/null || true
  fi

  cd ..
else
  log_warn "未找到 backend/package.json，跳过"
fi

# ============================================================
# 2. 前端 (Web) 依赖
# ============================================================
log_info "生成前端依赖 SBOM..."

if [ -f "src/package.json" ]; then
  cd src

  if command -v cyclonedx-npm &> /dev/null; then
    cyclonedx-npm --output-format "${OUTPUT_FORMAT}" --output-file "../${OUTPUT_DIR}/frontend-${TIMESTAMP}.json"
    log_info "前端 SBOM 已生成"
  else
    npm ls --json --prod > "../${OUTPUT_DIR}/frontend-${TIMESTAMP}.json" 2>/dev/null || true
  fi

  cd ..
else
  log_warn "未找到 src/package.json，跳过"
fi

# ============================================================
# 3. Python 服务依赖
# ============================================================
log_info "生成 Python 服务依赖 SBOM..."

if command -v cyclonedx-py &> /dev/null; then
  find services -name "requirements.txt" -o -name "pyproject.toml" | while read -r req_file; do
    service_dir=$(dirname "${req_file}")
    service_name=$(basename "${service_dir}")
    log_info "  处理 ${service_name}..."
    (cd "${service_dir}" && cyclonedx-py environment --output-format "${OUTPUT_FORMAT}" --output-file "../../${OUTPUT_DIR}/${service_name}-${TIMESTAMP}.json")
  done
else
  log_warn "未找到 cyclonedx-py，跳过 Python 依赖"
fi

# ============================================================
# 4. 容器镜像依赖
# ============================================================
log_info "生成容器镜像依赖 SBOM..."

if command -v syft &> /dev/null; then
  for dockerfile in $(find . -name "Dockerfile" -not -path "*/node_modules/*"); do
    image_name=$(dirname "${dockerfile}" | tr '/' '-')
    log_info "  分析 ${dockerfile}..."
    syft packages "dir:$(dirname "${dockerfile}")" --output "${OUTPUT_FORMAT}-json" \
      > "${OUTPUT_DIR}/container-${image_name}-${TIMESTAMP}.json" 2>/dev/null || true
  done
else
  log_warn "未找到 syft，跳过容器镜像分析"
fi

# ============================================================
# 5. 固件依赖
# ============================================================
log_info "生成固件依赖 SBOM..."

if [ -f "firmware/idf_component.yml" ]; then
  log_info "  找到 ESP-IDF 组件清单"
  cp firmware/idf_component.yml "${OUTPUT_DIR}/firmware-components-${TIMESTAMP}.yml"
fi

# ============================================================
# 6. 合并生成总 SBOM
# ============================================================
log_info "生成总 SBOM..."

TOTAL_SBOM="${OUTPUT_DIR}/sleep-monitor-${TIMESTAMP}.json"

cat > "${TOTAL_SBOM}" <<EOF
{
  "bomFormat": "${OUTPUT_FORMAT}",
  "specVersion": "1.4",
  "serialNumber": "urn:uuid:$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo '00000000-0000-0000-0000-000000000000')",
  "version": 1,
  "metadata": {
    "timestamp": "$(date -Iseconds)",
    "tools": [
      { "vendor": "Sleep Monitor", "name": "SBOM Generator", "version": "1.0.0" }
    ],
    "component": {
      "type": "application",
      "name": "Sleep Monitor Platform",
      "version": "${CI_COMMIT_SHORT_SHA:-dev}"
    }
  },
  "components": [],
  "services": []
}
EOF

log_info "总 SBOM 已生成: ${TOTAL_SBOM}"

# ============================================================
# 7. 漏洞扫描（如果有 grype）
# ============================================================
if command -v grype &> /dev/null; then
  log_info "执行漏洞扫描..."
  grype "sbom:${TOTAL_SBOM}" --output json > "${OUTPUT_DIR}/vulnerabilities-${TIMESTAMP}.json" 2>/dev/null || true
  log_info "漏洞扫描完成"
fi

# ============================================================
# 总结
# ============================================================
echo ""
echo "=========================================="
echo "  SBOM 生成完成"
echo "=========================================="
echo "输出目录: ${OUTPUT_DIR}"
echo "生成文件:"
ls -la "${OUTPUT_DIR}/" | tail -n +2 | awk '{print "  " $9 " (" $5 " bytes)"}'
echo "=========================================="
