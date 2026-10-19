@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AwesEvo

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js。
  echo   请先安装 Node.js 20 或更高版本：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   AwesEvo 正在启动，浏览器会自动打开...
echo   关闭这个窗口即停止服务。
echo.

start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:4173"
node server/index.js
pause
