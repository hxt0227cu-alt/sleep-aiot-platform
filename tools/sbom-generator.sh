#!/bin/bash
# ============================================================
# SBOM (Software Bill of Materials) 生成工具
#
# 功能：
#   1. 生成多语言项目的 SBOM（npm/pip/Go/Rust/容器镜像）
#   2. 合并多个 SBOM 为统一格式
#   3. 进行漏洞扫描（使用 grype）
#   4. 生成 SBOM 报告（JSON/SPDX/CycloneDX）
#
# 使用：
#   ./sbom-generator.sh [--project <路径>] [--output <目录>] [--format <格式>]
#
# 选项：
#   --project    项目根目录（默认当前目录）
#   --output     输出目录（默认 ./sbom-output）
#   --format     输出格式：cyclonedx/spdx/json（默认 cyclonedx）
#   --scan       启用漏洞扫描
#   --merge      合并所有 SBOM 为一个文件
# ============================================================

set -euo pipefail

# 配置
PROJECT_DIR="$(pwd)"
OUTPUT_DIR="${PROJECT_DIR}/sbom-output"
OUTPUT_FORMAT="cyclonedx"
ENABLE_SCAN=false
ENABLE_MERGE=false
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --project)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --scan)
      ENABLE_SCAN=true
      shift
      ;;
    --merge)
      ENABLE_MERGE=true
      shift
      ;;
    *)
      log_error "未知参数: $1"
      echo "使用: $0 [--project <路径>] [--output <目录>] [--format <格式>] [--scan] [--merge]"
      exit 1
      ;;
  esac
done

# 创建输出目录
mkdir -p "${OUTPUT_DIR}/${TIMESTAMP}"
WORK_DIR="${OUTPUT_DIR}/${TIMESTAMP}"

# 检查工具是否安装
check_tool() {
  if command -v "$1" &> /dev/null; then
    return 0
  else
    return 1
  fi
}

log_info "=========================================="
log_info "  SBOM 生成工具"
log_info "  项目: ${PROJECT_DIR}"
log_info "  输出: ${WORK_DIR}"
log_info "  格式: ${OUTPUT_FORMAT}"
log_info "  漏洞扫描: ${ENABLE_SCAN}"
log_info "  合并: ${ENABLE_MERGE}"
log_info "=========================================="

# 统计
SBOM_FILES=()
COMPONENT_COUNT=0

# ============================================================
# 1. npm 项目 SBOM 生成
# ============================================================
generate_npm_sbom() {
  local dir="$1"
  local name="$2"

  if [ ! -f "${dir}/package.json" ]; then
    return
  fi

  log_info "生成 npm SBOM: ${name}..."

  if check_tool "cyclonedx-npm"; then
    cd "${dir}"
    cyclonedx-npm --output-format "${OUTPUT_FORMAT}" --output-file "${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json" 2>&1 | tail -3 || true
    cd "${PROJECT_DIR}"
    SBOM_FILES+=("${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json")
    log_success "  npm SBOM 已生成: ${name}"
  elif check_tool "npm"; then
    # 使用 npm ls 作为备选
    cd "${dir}"
    npm ls --json --all > "${WORK_DIR}/${name}-npm-deps.json" 2>/dev/null || true
    cd "${PROJECT_DIR}"
    log_warning "  cyclonedx-npm 未安装，使用 npm ls 生成依赖列表"
  else
    log_warning "  npm 未安装，跳过"
  fi
}

# ============================================================
# 2. Python 项目 SBOM 生成
# ============================================================
generate_python_sbom() {
  local dir="$1"
  local name="$2"

  if [ ! -f "${dir}/requirements.txt" ] && [ ! -f "${dir}/pyproject.toml" ] && [ ! -f "${dir}/Pipfile" ]; then
    return
  fi

  log_info "生成 Python SBOM: ${name}..."

  if check_tool "cyclonedx-py"; then
    cd "${dir}"
    if [ -f "requirements.txt" ]; then
      cyclonedx-py requirements -i requirements.txt -o "${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json" --output-format "${OUTPUT_FORMAT}" 2>&1 | tail -3 || true
    elif [ -f "pyproject.toml" ]; then
      cyclonedx-py environment -o "${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json" --output-format "${OUTPUT_FORMAT}" 2>&1 | tail -3 || true
    fi
    cd "${PROJECT_DIR}"
    SBOM_FILES+=("${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json")
    log_success "  Python SBOM 已生成: ${name}"
  elif check_tool "pip"; then
    cd "${dir}"
    if [ -f "requirements.txt" ]; then
      pip list --format=json > "${WORK_DIR}/${name}-pip-deps.json" 2>/dev/null || true
    fi
    cd "${PROJECT_DIR}"
    log_warning "  cyclonedx-py 未安装，使用 pip list 生成依赖列表"
  else
    log_warning "  pip 未安装，跳过"
  fi
}

# ============================================================
# 3. 容器镜像 SBOM 生成
# ============================================================
generate_container_sbom() {
  local image="$1"
  local name="$2"

  log_info "生成容器镜像 SBOM: ${name} (${image})..."

  if check_tool "syft"; then
    syft "${image}" -o "${OUTPUT_FORMAT}-json" > "${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json" 2>&1 | tail -3 || true
    SBOM_FILES+=("${WORK_DIR}/${name}-sbom.${OUTPUT_FORMAT}.json")
    log_success "  容器镜像 SBOM 已生成: ${name}"
  else
    log_warning "  syft 未安装，跳过容器镜像 SBOM 生成"
  fi
}

# ============================================================
# 4. 固件 SBOM 生成
# ============================================================
generate_firmware_sbom() {
  local dir="$1"

  if [ ! -d "${dir}" ]; then
    return
  fi

  log_info "生成固件 SBOM..."

  # ESP-IDF 项目
  if [ -f "${dir}/idf_component.yml" ] || [ -f "${dir}/sdkconfig" ]; then
    if check_tool "idf.py"; then
      cd "${dir}"
      idf.py reconfigure 2>/dev/null || true
      # 生成依赖列表
      if [ -d "managed_components" ]; then
        find managed_components -name "idf_component.yml" -exec cat {} \; > "${WORK_DIR}/firmware-components.json" 2>/dev/null || true
      fi
      cd "${PROJECT_DIR}"
    fi
    log_success "  固件组件列表已生成"
  else
    log_warning "  未找到 ESP-IDF 项目，跳过"
  fi
}

# ============================================================
# 5. 漏洞扫描
# ============================================================
run_vulnerability_scan() {
  if [ "${ENABLE_SCAN}" != true ]; then
    return
  fi

  log_info "开始漏洞扫描..."

  if ! check_tool "grype"; then
    log_warning "  grype 未安装，跳过漏洞扫描"
    return
  fi

  for sbom_file in "${SBOM_FILES[@]}"; do
    if [ ! -f "${sbom_file}" ]; then
      continue
    fi

    local name=$(basename "${sbom_file}" .json)
    log_info "  扫描: ${name}..."

    grype "sbom:${sbom_file}" -o json > "${WORK_DIR}/${name}-vulnerabilities.json" 2>&1 || true
    grype "sbom:${sbom_file}" > "${WORK_DIR}/${name}-vulnerabilities.txt" 2>&1 || true

    # 统计漏洞数量
    if [ -f "${WORK_DIR}/${name}-vulnerabilities.json" ]; then
      local critical=$(grep -o '"severity": "Critical"' "${WORK_DIR}/${name}-vulnerabilities.json" | wc -l || echo 0)
      local high=$(grep -o '"severity": "High"' "${WORK_DIR}/${name}-vulnerabilities.json" | wc -l || echo 0)
      local medium=$(grep -o '"severity": "Medium"' "${WORK_DIR}/${name}-vulnerabilities.json" | wc -l || echo 0)
      local low=$(grep -o '"severity": "Low"' "${WORK_DIR}/${name}-vulnerabilities.json" | wc -l || echo 0)
      log_info "    Critical: ${critical}, High: ${high}, Medium: ${medium}, Low: ${low}"
    fi
  done

  log_success "  漏洞扫描完成"
}

# ============================================================
# 6. 合并 SBOM
# ============================================================
merge_sbom() {
  if [ "${ENABLE_MERGE}" != true ]; then
    return
  fi

  if [ ${#SBOM_FILES[@]} -eq 0 ]; then
    log_warning "  没有可合并的 SBOM 文件"
    return
  fi

  log_info "合并 SBOM 文件..."

  if check_tool "cyclonedx-cli"; then
    # 使用 cyclonedx-cli 合并
    local merge_cmd="cyclonedx-cli merge --input-files"
    for f in "${SBOM_FILES[@]}"; do
      merge_cmd="${merge_cmd} ${f}"
    done
    merge_cmd="${merge_cmd} --output-file ${WORK_DIR}/merged-sbom.${OUTPUT_FORMAT}.json"
    eval ${merge_cmd} 2>&1 | tail -3 || true
    log_success "  SBOM 已合并: merged-sbom.${OUTPUT_FORMAT}.json"
  else
    # 简单合并（JSON 数组合并）
    log_warning "  cyclonedx-cli 未安装，使用简单合并"
    echo '{"merged": true, "files": [' > "${WORK_DIR}/merged-sbom.json"
    for i in "${!SBOM_FILES[@]}"; do
      echo "  \"$(basename "${SBOM_FILES[$i]}")\"" >> "${WORK_DIR}/merged-sbom.json"
      if [ $i -lt $((${#SBOM_FILES[@]} - 1)) ]; then
        echo "," >> "${WORK_DIR}/merged-sbom.json"
      fi
    done
    echo "]}" >> "${WORK_DIR}/merged-sbom.json"
  fi
}

# ============================================================
# 7. 生成报告
# ============================================================
generate_report() {
  log_info "生成 SBOM 报告..."

  local report_file="${WORK_DIR}/sbom-report.md"

  cat > "${report_file}" << EOF
# SBOM (Software Bill of Materials) 报告

**生成时间**: $(date +"%Y-%m-%d %H:%M:%S")
**项目路径**: ${PROJECT_DIR}
**输出格式**: ${OUTPUT_FORMAT}
**漏洞扫描**: ${ENABLE_SCAN}

## 生成的 SBOM 文件

| 序号 | 文件名 | 类型 |
|------|--------|------|
EOF

  local i=1
  for f in "${SBOM_FILES[@]}"; do
    local name=$(basename "${f}")
    local type="unknown"
    if [[ "${name}" == *"npm"* ]]; then type="npm"; fi
    if [[ "${name}" == *"python"* ]] || [[ "${name}" == *"pip"* ]]; then type="Python"; fi
    if [[ "${name}" == *"container"* ]] || [[ "${name}" == *"image"* ]]; then type="Container"; fi
    if [[ "${name}" == *"firmware"* ]]; then type="Firmware"; fi
    echo "| ${i} | ${name} | ${type} |" >> "${report_file}"
    i=$((i + 1))
  done

  cat >> "${report_file}" << EOF

## 漏洞扫描结果

EOF

  if [ "${ENABLE_SCAN}" = true ]; then
    for f in "${WORK_DIR}"/*-vulnerabilities.txt; do
      if [ -f "${f}" ]; then
        local name=$(basename "${f}" -vulnerabilities.txt)
        echo "### ${name}" >> "${report_file}"
        echo '```' >> "${report_file}"
        cat "${f}" | head -30 >> "${report_file}"
        echo '```' >> "${report_file}"
        echo "" >> "${report_file}"
      fi
    done
  else
    echo "未启用漏洞扫描" >> "${report_file}"
  fi

  cat >> "${report_file}" << EOF

## 工具版本

- cyclonedx-npm: $(cyclonedx-npm --version 2>/dev/null || echo "未安装")
- cyclonedx-py: $(cyclonedx-py --version 2>/dev/null || echo "未安装")
- syft: $(syft version 2>/dev/null | head -1 || echo "未安装")
- grype: $(grype version 2>/dev/null | head -1 || echo "未安装")

---

*报告由 sbom-generator.sh 自动生成*
EOF

  log_success "  报告已生成: ${report_file}"

  # 创建符号链接到最新报告
  ln -sf "${WORK_DIR}" "${OUTPUT_DIR}/latest" 2>/dev/null || true
}

# ============================================================
# 主流程
# ============================================================
main() {
  echo ""

  # 扫描项目目录，生成各模块 SBOM
  log_info "扫描项目目录..."

  # 后端（npm）
  if [ -d "${PROJECT_DIR}/backend" ]; then
    generate_npm_sbom "${PROJECT_DIR}/backend" "backend"
  fi

  # 前端（npm）
  if [ -d "${PROJECT_DIR}/src" ]; then
    generate_npm_sbom "${PROJECT_DIR}/src" "frontend"
  fi

  # 小程序（npm）
  if [ -d "${PROJECT_DIR}/miniprogram" ]; then
    generate_npm_sbom "${PROJECT_DIR}/miniprogram" "miniprogram"
  fi

  # Python 服务
  if [ -d "${PROJECT_DIR}/services" ]; then
    find "${PROJECT_DIR}/services" -name "requirements.txt" -type f | while read -r req_file; do
      dir=$(dirname "${req_file}")
      name=$(basename "${dir}")
      generate_python_sbom "${dir}" "service-${name}"
    done
  fi

  # 微服务（Python）
  if [ -d "${PROJECT_DIR}/microservices" ]; then
    find "${PROJECT_DIR}/microservices" -name "requirements.txt" -type f | while read -r req_file; do
      dir=$(dirname "${req_file}")
      name=$(basename "${dir}")
      generate_python_sbom "${dir}" "microservice-${name}"
    done
  fi

  # 固件
  if [ -d "${PROJECT_DIR}/firmware" ]; then
    generate_firmware_sbom "${PROJECT_DIR}/firmware"
  fi

  # 容器镜像（如果有镜像列表）
  if [ -f "${PROJECT_DIR}/container-images.txt" ]; then
    while read -r image; do
      if [ -n "${image}" ]; then
        name=$(echo "${image}" | tr '/:' '_')
        generate_container_sbom "${image}" "container-${name}"
      fi
    done < "${PROJECT_DIR}/container-images.txt"
  fi

  # 漏洞扫描
  run_vulnerability_scan

  # 合并 SBOM
  merge_sbom

  # 生成报告
  generate_report

  echo ""
  log_info "=========================================="
  log_success "  SBOM 生成完成"
  log_info "  生成文件数: ${#SBOM_FILES[@]}"
  log_info "  输出目录: ${WORK_DIR}"
  log_info "  报告: ${WORK_DIR}/sbom-report.md"
  log_info "=========================================="
  echo ""
}

main "$@"
