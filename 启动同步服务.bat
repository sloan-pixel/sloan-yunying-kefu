@echo off
chcp 65001 >nul
cd /d %~dp0
set /p SYNC_TOKEN=请设置同步密码（两台电脑填同一个）： 
set PORT=8787
node sync\server.js
pause
