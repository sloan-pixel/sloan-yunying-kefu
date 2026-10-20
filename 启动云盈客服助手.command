#!/bin/bash
# Sloan云盈客服助手 · Mac 从源码启动（双击运行）。普通用户请用安装包（.dmg）。
cd "$(dirname "$0")"
LOG="安装日志.txt"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "==== $(date) ====" >> "$LOG"
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，需要先安装。" | tee -a "$LOG"
  open "https://nodejs.org/zh-cn/download"
  echo "已经为你打开 Node.js 下载页：下载 macOS 安装包（.pkg），装好后再双击本脚本。"
  read -n 1 -s -r -p "按任意键关闭此窗口"; exit 1
fi
echo "Node.js $(node -v)，npm $(npm -v)" | tee -a "$LOG"
if [ ! -d node_modules/electron ]; then
  echo "第一次运行，正在安装依赖（约 1~5 分钟）..." | tee -a "$LOG"
  npm install 2>&1 | tee -a "$LOG"
  if [ ! -d node_modules/electron ]; then echo "安装失败，请查看「安装日志.txt」"; read -n 1 -s -r; exit 1; fi
fi
echo "正在启动 Sloan云盈客服助手..." | tee -a "$LOG"
npm start 2>&1 | tee -a "$LOG"
