@echo off
title EdgeLink-Node
echo ============================================
echo   EdgeLink Node Startup
echo ============================================
echo.
echo Starting Node-RED (foreground)...
echo.
echo Opening browser - refresh page after Node-RED is ready (5s)...
start http://localhost:1880/index.html
echo.
echo ============================================
echo   Editor:  http://localhost:1880
echo   Monitor: http://localhost:1880/index.html
echo ============================================
echo.
echo Press Ctrl+C to stop Node-RED.
echo.
cd /d D:\nodered
D:\nodered\node.exe D:\nodered\node_modules\node-red\red.js --userDir D:\nodered\data
pause
