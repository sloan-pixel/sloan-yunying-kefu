#!/bin/bash
# 在 Mac 上打包出：Mac 安装包（.dmg，Apple 芯片 + Intel 各一个）和 Windows 免安装版（.zip）
cd "$(dirname "$0")"
LOG="打包日志.txt"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
export CSC_IDENTITY_AUTO_DISCOVERY=false
echo "==== $(date) 开始打包 ====" | tee "$LOG"
[ -d node_modules/electron-builder ] || npm install 2>&1 | tee -a "$LOG"
npx electron-builder --mac --win 2>&1 | tee -a "$LOG"
if ls dist/*.dmg >/dev/null 2>&1; then echo "BUILD_OK" | tee -a "$LOG"; open dist; else echo "BUILD_FAILED" | tee -a "$LOG"; fi
echo "完成，按任意键关闭"; read -n 1 -s -r
