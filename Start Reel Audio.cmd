@echo off
cd /d "%~dp0"
rem --use-system-ca lets Node trust the Windows certificate store,
rem which matters on networks that inspect TLS (corporate proxies).
node --use-system-ca server.js
pause
