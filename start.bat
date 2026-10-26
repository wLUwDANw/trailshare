@echo off
chcp 65001 >nul 2>&1
setlocal
title TrailShare 启动器

rem Move to the folder containing this script (correct cwd when double-clicked)
cd /d "%~dp0"

echo.
echo   TrailShare 启动器
echo   ----------------------------------------
echo.

rem ---------- 1/3 check Node.js ----------
echo [1/3] 检查 Node.js...
where node >nul 2>&1
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
echo   ✓ Node.js %NODE_VER%
echo.

rem ---------- 2/3 check dependencies ----------
echo [2/3] 检查依赖...
if not exist "node_modules\" goto :install_deps
echo   ✓ 依赖已存在
goto :deps_ready

:install_deps
echo   首次运行，正在安装依赖，约 1-2 分钟...
call npm install
if errorlevel 1 goto :install_failed
echo   ✓ 依赖安装完成

:deps_ready
echo.

rem ---------- 3/3 start dev server ----------
echo [3/3] 启动开发服务器...
echo   浏览器将自动打开 http://localhost:5173/
echo   按 Ctrl+C 停止服务器（若提示 Terminate batch job，输入 N 回车）
echo.

rem call is required: npm is a .cmd shim, calling it directly would end this batch
rem --open is passed only here; the dev script in package.json stays untouched
call npm run dev -- --open

echo.
echo 服务器已停止
echo.
pause
exit /b 0

rem ---------- error exits ----------
:no_node
echo   ✗ 未检测到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org
echo.
pause
exit /b 1

:install_failed
echo.
echo   ✗ 依赖安装失败，请检查网络连接后重试
echo.
pause
exit /b 1
