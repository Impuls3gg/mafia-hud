@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "HOST=%~1"
set "ADDRESS=%~2"
if "%HOST%"=="" set /p "HOST=IP сервера: "
if "%HOST%"=="" goto missing
if "%ADDRESS%"=="" if "%~1"=="" set /p "ADDRESS=Домен (если его нет, нажмите Enter): "
if "%ADDRESS%"=="" set "ADDRESS=%HOST%"
tar -cf - server.js judge.html Dockerfile compose.yaml Caddyfile server-setup.sh | ssh -o StrictHostKeyChecking=accept-new root@%HOST% "mkdir -p /opt/mafia-judge && tar -xf - -C /opt/mafia-judge --no-same-owner && sed -i 's/\r$//' /opt/mafia-judge/server-setup.sh && bash /opt/mafia-judge/server-setup.sh %ADDRESS%"
if errorlevel 1 echo Установка не завершена. Проверьте сообщения выше.
pause
exit /b

:missing
echo Нужно указать IP сервера.
pause
exit /b 1
