#!/bin/bash
# ============================================================
# 容器镜像签名工具
#
# 功能：
#   1. 使用 Cosign 对容器镜像进行签名
#   2. 验证镜像签名
#   3. 生成签名证明（Attestation）
#   4. 管理签名密钥
#
# 使用：
#   ./image-sign.sh sign --image <镜像> --key <密钥路径>
#   ./image-sign.sh verify --image <镜像> --key <公钥路径>
#   ./image-sign.sh generate-key --output <密钥路径>
#
# 命令：
#   sign          签名镜像
#   verify        验证镜像签名
#   generate-key  生成签名密钥对
#   attest        生成签名证明
# ============================================================

set -euo pipefail

# 配置
COSIGN_BIN="${COSIGN_BIN:-cosign}"
KEY_OUTPUT_DIR="${KEY_OUTPUT_DIR:-./signing-keys}"
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

# 检查 cosign 是否安装
check_cosign() {
  if ! command -v "${COSIGN_BIN}" &> /dev/null; then
    log_error "cosign 未安装，请先安装 cosign"
    log_info "安装方法: https://docs.sigstore.dev/cosign/installation/"
    exit 1
  fi
}

# ============================================================
# 生成密钥对
# ============================================================
generate_key() {
  local output_path=""
  local password=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --output)
        output_path="$2"
        shift 2
        ;;
      --password)
        password="$2"
        shift 2
        ;;
      *)
        log_error "未知参数: $1"
        exit 1
        ;;
    esac
  done

  if [ -z "${output_path}" ]; then
    output_path="${KEY_OUTPUT_DIR}/cosign-key-${TIMESTAMP}"
  fi

  log_info "生成签名密钥对..."
  log_info "  输出路径: ${output_path}"

  mkdir -p "$(dirname "${output_path}")"

  if [ -n "${password}" ]; then
    COSIGN_PASSWORD="${password}" "${COSIGN_BIN}" generate-key-pair \
      --output-key-prefix "${output_path}" 2>&1
  else
    "${COSIGN_BIN}" generate-key-pair \
      --output-key-prefix "${output_path}" 2>&1
  fi

  if [ -f "${output_path}.key" ] && [ -f "${output_path}.pub" ]; then
    log_success "密钥对生成成功"
    log_info "  私钥: ${output_path}.key"
    log_info "  公钥: ${output_path}.pub"
    log_warning "  请妥善保管私钥，不要提交到代码仓库"
  else
    log_error "密钥对生成失败"
    exit 1
  fi
}

# ============================================================
# 签名镜像
# ============================================================
sign_image() {
  local image=""
  local key_path=""
  local password=""
  local tlog=true
  local recursive=false
  local attestation=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --image)
        image="$2"
        shift 2
        ;;
      --key)
        key_path="$2"
        shift 2
        ;;
      --password)
        password="$2"
        shift 2
        ;;
      --no-tlog)
        tlog=false
        shift
        ;;
      --recursive)
        recursive=true
        shift
        ;;
      --attestation)
        attestation="$2"
        shift 2
        ;;
      *)
        log_error "未知参数: $1"
        exit 1
        ;;
    esac
  done

  if [ -z "${image}" ]; then
    log_error "必须指定 --image 参数"
    exit 1
  fi

  if [ -z "${key_path}" ]; then
    log_error "必须指定 --key 参数（私钥路径）"
    exit 1
  fi

  if [ ! -f "${key_path}" ]; then
    log_error "私钥文件不存在: ${key_path}"
    exit 1
  fi

  log_info "签名镜像..."
  log_info "  镜像: ${image}"
  log_info "  私钥: ${key_path}"
  log_info "  透明度日志: ${tlog}"

  local cosign_args=("sign")

  if [ -n "${password}" ]; then
    export COSIGN_PASSWORD="${password}"
  fi

  cosign_args+=("--key" "${key_path}")

  if [ "${tlog}" = false ]; then
    cosign_args+=("--tlog-upload=false")
  fi

  if [ "${recursive}" = true ]; then
    cosign_args+=("--recursive")
  fi

  if [ -n "${attestation}" ]; then
    cosign_args+=("--attestation" "${attestation}")
    cosign_args+=("--type" "intoto")
  fi

  cosign_args+=("${image}")

  # 执行签名
  if "${COSIGN_BIN}" "${cosign_args[@]}" 2>&1; then
    log_success "镜像签名成功"
    log_info "  签名已存储在镜像仓库中"
  else
    log_error "镜像签名失败"
    exit 1
  fi
}

# ============================================================
# 验证镜像签名
# ============================================================
verify_image() {
  local image=""
  local key_path=""
  local certificate_identity=""
  local certificate_oidc_issuer=""
  local output_format="text"

  while [[ $# -gt 0 ]]; do
    case $1 in
      --image)
        image="$2"
        shift 2
        ;;
      --key)
        key_path="$2"
        shift 2
        ;;
      --certificate-identity)
        certificate_identity="$2"
        shift 2
        ;;
      --certificate-oidc-issuer)
        certificate_oidc_issuer="$2"
        shift 2
        ;;
      --output)
        output_format="$2"
        shift 2
        ;;
      *)
        log_error "未知参数: $1"
        exit 1
        ;;
    esac
  done

  if [ -z "${image}" ]; then
    log_error "必须指定 --image 参数"
    exit 1
  fi

  log_info "验证镜像签名..."
  log_info "  镜像: ${image}"

  local cosign_args=("verify")

  if [ -n "${key_path}" ]; then
    if [ ! -f "${key_path}" ]; then
      log_error "公钥文件不存在: ${key_path}"
      exit 1
    fi
    cosign_args+=("--key" "${key_path}")
    log_info "  公钥: ${key_path}"
  elif [ -n "${certificate_identity}" ] && [ -n "${certificate_oidc_issuer}" ]; then
    cosign_args+=("--certificate-identity" "${certificate_identity}")
    cosign_args+=("--certificate-oidc-issuer" "${certificate_oidc_issuer}")
    log_info "  证书身份: ${certificate_identity}"
    log_info "  OIDC Issuer: ${certificate_oidc_issuer}"
  else
    log_error "必须指定 --key 或 --certificate-identity + --certificate-oidc-issuer"
    exit 1
  fi

  cosign_args+=("--output" "${output_format}")
  cosign_args+=("${image}")

  # 执行验证
  if "${COSIGN_BIN}" "${cosign_args[@]}" 2>&1; then
    log_success "镜像签名验证通过"
  else
    log_error "镜像签名验证失败"
    log_warning "  镜像可能被篡改或来源不可信"
    exit 1
  fi
}

# ============================================================
# 生成 Attestation（签名证明）
# ============================================================
attest_image() {
  local image=""
  local key_path=""
  local predicate_type="slsaprovenance"
  local predicate_path=""
  local password=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --image)
        image="$2"
        shift 2
        ;;
      --key)
        key_path="$2"
        shift 2
        ;;
      --predicate-type)
        predicate_type="$2"
        shift 2
        ;;
      --predicate)
        predicate_path="$2"
        shift 2
        ;;
      --password)
        password="$2"
        shift 2
        ;;
      *)
        log_error "未知参数: $1"
        exit 1
        ;;
    esac
  done

  if [ -z "${image}" ] || [ -z "${key_path}" ] || [ -z "${predicate_path}" ]; then
    log_error "必须指定 --image, --key, --predicate 参数"
    exit 1
  fi

  if [ -n "${password}" ]; then
    export COSIGN_PASSWORD="${password}"
  fi

  log_info "生成 Attestation..."
  log_info "  镜像: ${image}"
  log_info "  谓词类型: ${predicate_type}"
  log_info "  谓词文件: ${predicate_path}"

  "${COSIGN_BIN}" attest \
    --key "${key_path}" \
    --type "${predicate_type}" \
    --predicate "${predicate_path}" \
    "${image}" 2>&1

  log_success "Attestation 生成成功"
}

# ============================================================
# 批量签名
# ============================================================
batch_sign() {
  local image_list_file=""
  local key_path=""
  local password=""

  while [[ $# -gt 0 ]]; do
    case $1 in
      --images)
        image_list_file="$2"
        shift 2
        ;;
      --key)
        key_path="$2"
        shift 2
        ;;
      --password)
        password="$2"
        shift 2
        ;;
      *)
        log_error "未知参数: $1"
        exit 1
        ;;
    esac
  done

  if [ -z "${image_list_file}" ] || [ -z "${key_path}" ]; then
    log_error "必须指定 --images 和 --key 参数"
    exit 1
  fi

  if [ ! -f "${image_list_file}" ]; then
    log_error "镜像列表文件不存在: ${image_list_file}"
    exit 1
  fi

  log_info "批量签名镜像..."
  log_info "  镜像列表: ${image_list_file}"
  log_info "  私钥: ${key_path}"

  local success_count=0
  local fail_count=0

  while read -r image; do
    if [ -z "${image}" ] || [[ "${image}" == \#* ]]; then
      continue
    fi

    log_info "  签名: ${image}"
    if sign_image --image "${image}" --key "${key_path}" --password "${password}" --no-tlog 2>/dev/null; then
      success_count=$((success_count + 1))
    else
      fail_count=$((fail_count + 1))
      log_error "  签名失败: ${image}"
    fi
  done < "${image_list_file}"

  echo ""
  log_info "批量签名完成"
  log_info "  成功: ${success_count}"
  log_info "  失败: ${fail_count}"
}

# ============================================================
# 显示帮助
# ============================================================
show_help() {
  cat << EOF
容器镜像签名工具

使用方法:
  ./image-sign.sh <命令> [选项]

命令:
  sign          签名镜像
  verify        验证镜像签名
  generate-key  生成签名密钥对
  attest        生成签名证明 (Attestation)
  batch-sign    批量签名镜像
  help          显示帮助

签名镜像:
  ./image-sign.sh sign --image <镜像> --key <私钥路径> [--password <密码>] [--no-tlog] [--recursive]

验证镜像签名:
  ./image-sign.sh verify --image <镜像> --key <公钥路径>

生成密钥对:
  ./image-sign.sh generate-key --output <密钥前缀> [--password <密码>]

生成 Attestation:
  ./image-sign.sh attest --image <镜像> --key <私钥路径> --predicate <谓词文件> --predicate-type <类型>

批量签名:
  ./image-sign.sh batch-sign --images <镜像列表文件> --key <私钥路径>

示例:
  # 生成密钥对
  ./image-sign.sh generate-key --output ./keys/cosign

  # 签名镜像
  ./image-sign.sh sign --image registry.example.com/app:v1.0.0 --key ./keys/cosign.key

  # 验证镜像签名
  ./image-sign.sh verify --image registry.example.com/app:v1.0.0 --key ./keys/cosign.pub

EOF
}

# ============================================================
# 主入口
# ============================================================
main() {
  if [ $# -eq 0 ]; then
    show_help
    exit 0
  fi

  local command="$1"
  shift

  case "${command}" in
    sign)
      check_cosign
      sign_image "$@"
      ;;
    verify)
      check_cosign
      verify_image "$@"
      ;;
    generate-key)
      check_cosign
      generate_key "$@"
      ;;
    attest)
      check_cosign
      attest_image "$@"
      ;;
    batch-sign)
      check_cosign
      batch_sign "$@"
      ;;
    help|--help|-h)
      show_help
      ;;
    *)
      log_error "未知命令: ${command}"
      show_help
      exit 1
      ;;
  esac
}

main "$@"
