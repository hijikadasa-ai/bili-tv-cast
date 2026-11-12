@echo off
chcp 936 >nul
title 小电视投屏 - 安装到浏览器
setlocal enabledelayedexpansion

set "SRC=%~dp0extension"
set "DST=%LOCALAPPDATA%\BiliTVCast\extension"

echo.
echo ==========================================================
echo    小电视投屏   安装到浏览器
echo ==========================================================
echo.

if not exist "%SRC%\manifest.json" (
    echo [错误] 找不到 extension 目录。
    echo        请把整个文件夹完整解压后再运行本文件。
    echo.
    pause
    exit /b 1
)

echo [1/3] 复制扩展文件到固定目录
if exist "%DST%" rmdir /s /q "%DST%" 2>nul
xcopy "%SRC%" "%DST%\" /E /I /Y /Q >nul
if not exist "%DST%\manifest.json" (
    echo [错误] 复制失败，可能是目录权限问题。
    echo.
    pause
    exit /b 1
)
echo       完成: %DST%
echo.

echo [2/3] 查找浏览器
set "BROWSER="
if not defined BROWSER if exist "%LOCALAPPDATA%\360ChromeX\Chrome\Application\360ChromeX.exe" set "BROWSER=%LOCALAPPDATA%\360ChromeX\Chrome\Application\360ChromeX.exe"
if not defined BROWSER if exist "C:\Program Files\360ChromeX\Chrome\Application\360ChromeX.exe" set "BROWSER=C:\Program Files\360ChromeX\Chrome\Application\360ChromeX.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\360ChromeX\Chrome\Application\360ChromeX.exe" set "BROWSER=C:\Program Files (x86)\360ChromeX\Chrome\Application\360ChromeX.exe"
if not defined BROWSER if exist "D:\360jisu\360ChromeX\Chrome\Application\360ChromeX.exe" set "BROWSER=D:\360jisu\360ChromeX\Chrome\Application\360ChromeX.exe"
if not defined BROWSER if exist "D:\360ChromeX\Chrome\Application\360ChromeX.exe" set "BROWSER=D:\360ChromeX\Chrome\Application\360ChromeX.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\360Chrome\Chrome\Application\360chrome.exe" set "BROWSER=%LOCALAPPDATA%\360Chrome\Chrome\Application\360chrome.exe"
if not defined BROWSER if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if defined BROWSER (
    echo       找到: !BROWSER!
    echo.
    echo [3/3] 打开扩展管理页
    start "" "!BROWSER!" "chrome://extensions/"
    echo       如果窗口没跳到扩展页，手动在地址栏输入 chrome://extensions/
) else (
    echo       没自动找到浏览器，请自己打开 chrome://extensions/
)

echo.
echo ----------------------------------------------------------
echo   在浏览器里完成这三步:
echo     1. 右上角打开「开发者模式」开关
echo     2. 点「加载已解压的扩展程序」
echo     3. 选中下面这个目录（已帮你打开资源管理器）
echo ----------------------------------------------------------
echo.

if exist "%DST%" explorer "%DST%"

echo   目录: %DST%
echo.
echo   加载成功后，工具栏会出现粉色小电视图标。
echo   投屏前先双击「1.启动桥接.bat」，并保持那个黑窗口开着。
echo.
pause
