@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Reel Lab: проверка сервера
echo.
echo  Reel Lab — проверка сервера: служба, распознавание речи, ИИ, бот, HTTPS, оплата
echo  ------------------------------------------------------------------------------
set "IP="
set /p IP=  IP-адрес сервера:
if defined IP set "IP=%IP: =%"
if not defined IP (
  echo  IP-адрес не введён.
  pause
  exit /b 1
)
ssh-keygen -R %IP% >nul 2>&1
echo  Спросит пароль root ^(при вводе он не виден — это нормально; вставить — правая кнопка мыши^)...
ssh -t -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 root@%IP% "bash /opt/reellab/app/deploy/check.sh"
echo.
echo  Строки с ✘ — что исправить; под каждой написано, как. ✔ — работает, • — не подключено ^(можно позже^).
pause
