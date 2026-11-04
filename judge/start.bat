@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите его с сайта https://nodejs.org
  pause
  exit /b 1
)
where ssh >nul 2>nul
if errorlevel 1 (
  echo Не найден ssh. Включите компонент "Клиент OpenSSH" в параметрах Windows.
  pause
  exit /b 1
)
start "" /b node server.js
echo Скопируйте адрес вида https://....lhr.life и вставьте его в пульт, блок "Судья с телефона".
echo Закрытие этого окна отключит судью.
:tunnel
ssh -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 80:localhost:8787 nokey@localhost.run
echo Туннель отключился, подключаюсь заново. Адрес может смениться.
timeout /t 5 /nobreak >nul
goto tunnel
