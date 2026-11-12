@echo off
chcp 936 >nul
title 小电视投屏 · 本地桥接服务
cd /d "%~dp0"

rem 优先用自带的便携 Node，没有再用系统里装的
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   没有检测到 Node.js，包内也没有自带运行时。
    echo   请到 https://nodejs.org 安装 LTS 版本后重新双击本文件。
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)

echo.
echo   正在启动本地桥接服务，请保持本窗口开着…
echo   关闭窗口或按 Ctrl+C 即可停止投屏服务。
echo.

"%NODE%" bridge\server.js

echo.
echo   服务已退出。
pause
