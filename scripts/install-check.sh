#!/usr/bin/env bash
#
# 院内安装自检脚本 —— 部署前/部署后一键体检
#
# 用法：
#   bash scripts/install-check.sh
#   bash scripts/install-check.sh --no-ports
#
# 行为：
#   1. 检查 Node 版本（≥20）
#   2. 检查编译产物 dist/index.js 是否存在（没构建则提示 npm run build）
#   3. 检查 .env 必填项是否齐全（与 src/shared/env.ts 的 REQUIRED_ENV_KEYS 对齐）
#   4. 检查通道配置 channels/*.yaml 是否至少一份
#   5. 调用 node dist/gateway/cli.js doctor 做综合自检
#
# 退出码：存在阻断项时返回 1，便于 CI / 装机脚本判断。

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

echo "== lab-ops-console 安装自检 =="
echo "安装目录: ${ROOT}"

# 1. Node 版本
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "${NODE_BIN}" >/dev/null 2>&1; then
  echo "[缺项] 找不到 node 可执行文件，请先安装 Node 20+"
  exit 1
fi
NODE_MAJOR="$(${NODE_BIN} -v | cut -d. -f1 | tr -d 'v')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "[缺项] Node 版本过低：$(${NODE_BIN} -v)，要求 ≥20"
  exit 1
fi
echo "[通过] Node 版本：$(${NODE_BIN} -v)"

# 2. 构建产物
if [ ! -f dist/index.js ]; then
  echo "[缺项] 尚未构建（缺少 dist/index.js）；请先执行：npm ci && npm run build"
  # 不立即退出：doctor 也会报，但这里是装机前置，明确提示
  BUILD_MISSING=1
else
  echo "[通过] 构建产物 dist/index.js 存在"
fi

# 3. .env 必填项（与 src/shared/env.ts REQUIRED_ENV_KEYS 对齐）
REQUIRED_KEYS=(
  DEVICE_LISTEN_PORT
  LIS_FHIR_BASE_URL
  LIS_FHIR_TOKEN
  FHIR_BASE_URL
  FHIR_TOKEN
  MODELS_BASE_URL
  MODELS_API_KEY
  MODELS_MODEL
)
ENV_FILE="${ROOT}/.env"
ENV_MISSING=0
if [ -f "${ENV_FILE}" ]; then
  for key in "${REQUIRED_KEYS[@]}"; do
    # 兼容 KEY=value 与 KEY="value" 两种写法
    if ! grep -qE "^[[:space:]]*${key}=" "${ENV_FILE}"; then
      echo "[缺项] .env 缺少必填项：${key}"
      ENV_MISSING=1
    fi
  done
  [ "${ENV_MISSING}" -eq 0 ] && echo "[通过] .env 必填项齐备（${#REQUIRED_KEYS[@]} 项）"
else
  echo "[缺项] 找不到 .env（请 cp .env.example .env 并补齐）"
  ENV_MISSING=1
fi

# 4. 通道配置
CHANNEL_COUNT=$(find channels -maxdepth 1 -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | wc -l | tr -d ' ')
if [ "${CHANNEL_COUNT}" -gt 0 ]; then
  echo "[通过] 发现 ${CHANNEL_COUNT} 份通道配置"
else
  echo "[缺项] channels/ 下没有 yaml 配置，请至少配置一条仪器通道"
fi

# 5. 综合自检（doctor）
if [ -f dist/gateway/cli.js ]; then
  echo "---- doctor 综合自检 ----"
  if [ "${1:-}" = "--no-ports" ]; then
    "${NODE_BIN}" dist/gateway/cli.js doctor --no-ports || true
  else
    "${NODE_BIN}" dist/gateway/cli.js doctor || true
  fi
else
  echo "[提示] 尚未构建，跳过 doctor（请先 npm run build）"
fi

# 汇总退出码
if [ "${BUILD_MISSING:-0}" -eq 1 ] || [ "${ENV_MISSING}" -eq 1 ] || [ "${CHANNEL_COUNT}" -eq 0 ]; then
  echo "结论：存在阻断项，请按上面提示补齐后再启动服务。"
  exit 1
fi
echo "结论：前置体检通过，可以启动服务（npm start / pm2 / systemctl）。"
exit 0
