@echo off
chcp 65001 >nul
set "HOST=%~1"
set "ADDRESS=%~2"
if "%HOST%"=="" set /p "HOST=IP сервера: "
if "%HOST%"=="" goto missing
if "%ADDRESS%"=="" if "%~1"=="" set /p "ADDRESS=Новый домен (если не нужен, нажмите Enter): "
ssh -o StrictHostKeyChecking=accept-new root@%HOST% "(command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)) && ([ -d /opt/mafia-hud/.git ] || git clone -q https://github.com/Impuls3gg/mafia-hud.git /opt/mafia-hud) && FALLBACK_ADDRESS=%HOST% bash /opt/mafia-hud/judge/update.sh %ADDRESS%"
if errorlevel 1 echo Установка не завершена. Проверьте сообщения выше.
pause
exit /b

:missing
echo Нужно указать IP сервера.
pause
exit /b 1
