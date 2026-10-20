@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul || (echo 没有找到 Node.js，请先到 https://nodejs.org 安装 LTS 版本 & start https://nodejs.org/zh-cn/download & pause & exit /b 1)
if not exist node_modules\electron (
  echo 第一次运行，正在安装依赖，大约需要几分钟...
  call npm install
)
call npm start
