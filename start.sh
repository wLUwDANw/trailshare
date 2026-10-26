#!/bin/bash
# TrailShare 启动器（macOS 双击 / Linux 直接运行）
# 首次使用需要给执行权限：chmod +x start.command

set -u

# 切到脚本所在目录，保证双击时工作目录正确
cd "$(dirname "$0")" || exit 1

echo ""
echo "  TrailShare 启动器"
echo "  ----------------------------------------"
echo ""

# ---------- 1/3 检查 Node.js ----------
echo "[1/3] 检查 Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org"
  echo ""
  read -r -p "按回车键退出..." _
  exit 1
fi
echo "  ✓ Node.js $(node --version)"
echo ""

# ---------- 2/3 检查依赖 ----------
echo "[2/3] 检查依赖..."
if [ ! -d "node_modules" ]; then
  echo "  首次运行，正在安装依赖，约 1-2 分钟..."
  if ! npm install; then
    echo ""
    echo "  ✗ 依赖安装失败，请检查网络连接后重试"
    echo ""
    read -r -p "按回车键退出..." _
    exit 1
  fi
  echo "  ✓ 依赖安装完成"
else
  echo "  ✓ 依赖已存在"
fi
echo ""

# ---------- 3/3 启动开发服务器 ----------
echo "[3/3] 启动开发服务器..."
echo "  浏览器将自动打开 http://localhost:5173/"
echo "  按 Ctrl+C 停止服务器"
echo ""

# --open 只在这里传，package.json 的 dev 脚本保持原样
npm run dev -- --open

echo ""
echo "服务器已停止"
echo ""
read -r -p "按回车键退出..." _ || true
exit 0
