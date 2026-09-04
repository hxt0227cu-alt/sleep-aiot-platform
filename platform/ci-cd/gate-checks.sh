#!/bin/bash
# 门禁检查脚本
#
# 在部署前执行质量门禁检查，包括：
# - 代码质量
# - 测试覆盖率
# - 安全漏洞
# - 依赖许可证
# - 配置合规性

set -euo pipefail

# 配置
THRESHOLD_COVERAGE="${THRESHOLD_COVERAGE:-80}"
THRESHOLD_CRITICAL_VULNS="${THRESHOLD_CRITICAL_VULNS:-0}"
THRESHOLD_HIGH_VULNS="${THRESHOLD_HIGH_VULNS:-5}"
THRESHOLD_BLOCKER_ISSUES="${THRESHOLD_BLOCKER_ISSUES:-0}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0
WARNINGS=0

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; WARNINGS=$((WARNINGS + 1)); }

echo "=========================================="
echo "  质量门禁检查"
echo "=========================================="
echo ""

# ============================================================
# 1. 测试覆盖率检查
# ============================================================
echo "[1/6] 测试覆盖率检查"

if [ -f "backend/coverage/lcov.info" ]; then
  COVERAGE=$(grep -oP 'Lines\s*:\s*\K[0-9.]+' backend/coverage/lcov.info 2>/dev/null || echo "0")
  if (( $(echo "$COVERAGE >= $THRESHOLD_COVERAGE" | bc -l) )); then
    log_pass "测试覆盖率 ${COVERAGE}% >= ${THRESHOLD_COVERAGE}%"
  else
    log_fail "测试覆盖率 ${COVERAGE}% < ${THRESHOLD_COVERAGE}%"
  fi
else
  log_warn "未找到覆盖率报告，跳过检查"
fi

# ============================================================
# 2. 安全漏洞检查
# ============================================================
echo ""
echo "[2/6] 安全漏洞检查"

if [ -f "sast-report.json" ]; then
  CRITICAL_VULNS=$(jq '[.[] | select(.Severity=="CRITICAL")] | length' sast-report.json 2>/dev/null || echo "0")
  HIGH_VULNS=$(jq '[.[] | select(.Severity=="HIGH")] | length' sast-report.json 2>/dev/null || echo "0")

  if [ "$CRITICAL_VULNS" -le "$THRESHOLD_CRITICAL_VULNS" ]; then
    log_pass "严重漏洞数 ${CRITICAL_VULNS} <= ${THRESHOLD_CRITICAL_VULNS}"
  else
    log_fail "严重漏洞数 ${CRITICAL_VULNS} > ${THRESHOLD_CRITICAL_VULNS}"
  fi

  if [ "$HIGH_VULNS" -le "$THRESHOLD_HIGH_VULNS" ]; then
    log_pass "高危漏洞数 ${HIGH_VULNS} <= ${THRESHOLD_HIGH_VULNS}"
  else
    log_fail "高危漏洞数 ${HIGH_VULNS} > ${THRESHOLD_HIGH_VULNS}"
  fi
else
  log_warn "未找到 SAST 报告，跳过检查"
fi

# ============================================================
# 3. 密钥泄露检查
# ============================================================
echo ""
echo "[3/6] 密钥泄露检查"

if [ -f "secret-scan-report.json" ]; then
  SECRET_LEAKS=$(jq 'length' secret-scan-report.json 2>/dev/null || echo "0")
  if [ "$SECRET_LEAKS" -eq 0 ]; then
    log_pass "未发现密钥泄露"
  else
    log_fail "发现 ${SECRET_LEAKS} 处疑似密钥泄露"
  fi
else
  log_warn "未找到密钥扫描报告，跳过检查"
fi

# ============================================================
# 4. 代码质量检查
# ============================================================
echo ""
echo "[4/6] 代码质量检查"

if [ -f "backend/lint-report.json" ]; then
  LINT_ERRORS=$(jq '.errors' backend/lint-report.json 2>/dev/null || echo "0")
  LINT_WARNINGS=$(jq '.warnings' backend/lint-report.json 2>/dev/null || echo "0")

  if [ "$LINT_ERRORS" -eq 0 ]; then
    log_pass "Lint 错误数 ${LINT_ERRORS}"
  else
    log_fail "Lint 错误数 ${LINT_ERRORS} > 0"
  fi

  if [ "$LINT_WARNINGS" -le 50 ]; then
    log_pass "Lint 警告数 ${LINT_WARNINGS} <= 50"
  else
    log_warn "Lint 警告数 ${LINT_WARNINGS} > 50"
  fi
else
  log_warn "未找到 Lint 报告，跳过检查"
fi

# ============================================================
# 5. 依赖许可证检查
# ============================================================
echo ""
echo "[5/6] 依赖许可证检查"

if [ -f "sbom.json" ]; then
  # 检查是否有 GPL/AGPL 等传染性许可证
  GPL_DEPS=$(jq '[.components[] | select(.license | test("GPL|AGPL|LGPL"))] | length' sbom.json 2>/dev/null || echo "0")
  if [ "$GPL_DEPS" -eq 0 ]; then
    log_pass "未发现传染性许可证依赖"
  else
    log_fail "发现 ${GPL_DEPS} 个传染性许可证依赖"
  fi
else
  log_warn "未找到 SBOM 文件，跳过检查"
fi

# ============================================================
# 6. 配置合规性检查
# ============================================================
echo ""
echo "[6/6] 配置合规性检查"

# 检查是否有硬编码的生产环境密钥
HARDCODED_SECRETS=$(grep -rE '(password|secret|token|api_key)\s*[:=]\s*["'\''][^"'\'']{8,}' \
  --include="*.ts" --include="*.js" --include="*.yaml" --include="*.yml" \
  backend/src platform/k8s 2>/dev/null | grep -v "process.env" | grep -v "valueFrom" | wc -l)

if [ "$HARDCODED_SECRETS" -eq 0 ]; then
  log_pass "未发现硬编码密钥"
else
  log_fail "发现 ${HARDCODED_SECRETS} 处疑似硬编码密钥"
fi

# ============================================================
# 总结
# ============================================================
echo ""
echo "=========================================="
echo "  门禁检查总结"
echo "=========================================="
echo -e "  通过: ${GREEN}${PASSED}${NC}"
echo -e "  失败: ${RED}${FAILED}${NC}"
echo -e "  警告: ${YELLOW}${WARNINGS}${NC}"
echo "=========================================="

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo -e "${RED}门禁检查未通过，阻止部署！${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}门禁检查通过，允许部署。${NC}"
  exit 0
fi
