@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Reel Lab: установка на сервер
cd /d "%~dp0"
echo.
echo  Reel Lab — установка или обновление на сервере
echo  ------------------------------------------------
echo  Этот же файл обновляет бота и применяет новые настройки из settings.txt.
echo.

rem --- 1. Настройки: settings.txt рядом с этим файлом -------------------------------
if exist "settings.txt" goto check_token
if not exist "settings.example.txt" (
  echo  Не найден settings.example.txt — скачай папку с GitHub заново целиком.
  pause
  exit /b 1
)
copy /y "settings.example.txt" "settings.txt" >nul

:edit
echo  Сейчас откроется файл настроек settings.txt.
echo  Впиши данные после знаков «=», сохрани файл ^(Ctrl+S^), закрой Блокнот —
echo  и вернись в это окно.
start "" notepad "settings.txt"
echo.
echo  Когда сохранишь settings.txt — нажми здесь любую клавишу...
pause >nul

:check_token
findstr /r /c:"^ *TELEGRAM_BOT_TOKEN *= *[0-9][0-9]*:..." "settings.txt" >nul
if not errorlevel 1 goto token_ok
echo.
echo  В settings.txt не вписан токен бота ^(строка TELEGRAM_BOT_TOKEN=^) или файл не сохранён.
echo  Токен присылает @BotFather — подробно в README.md, шаг 2.
goto edit
:token_ok

rem --- 2. Программы Windows, которые нужны для отправки на сервер ------------------------
where ssh >nul 2>&1
if errorlevel 1 (
  echo  В Windows нет программы ssh. Включи её: Параметры → Приложения → Дополнительные компоненты →
  echo  «Клиент OpenSSH» → Установить. Потом запусти этот файл ещё раз.
  pause
  exit /b 1
)
where tar >nul 2>&1
if errorlevel 1 (
  echo  В Windows нет программы tar ^(она есть в Windows 10 с 2018 года и в Windows 11^). Обнови Windows.
  pause
  exit /b 1
)

rem --- 3. Адрес сервера ---------------------------------------------------------------
echo.
set "IP="
set /p IP=  IP-адрес сервера ^(из панели хостинга, например 185.12.34.56^):
rem Пробелы из скопированного адреса убираем: «1.2.3.4 » сломал бы копирование.
if defined IP set "IP=%IP: =%"
if not defined IP (
  echo  IP-адрес не введён. Он есть в панели хостинга ^(Timeweb Cloud — в карточке сервера^).
  pause
  exit /b 1
)
rem Сервер переустановили на том же адресе — старый «отпечаток» сервера забываем, иначе ssh откажет.
ssh-keygen -R %IP% >nul 2>&1
set "SSHOPT=-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=10"

rem --- 4. Упаковка и отправка -----------------------------------------------------------
set "PACK=%TEMP%\reellab-upload.tar.gz"
set "SETS=%TEMP%\reellab-settings.txt"
echo.
echo  1/3 Упаковываю программу...
del /q "%PACK%" 2>nul
tar -czf "%PACK%" --exclude=./settings.txt --exclude=./.git --exclude=./data --exclude=__pycache__ --exclude=*.cmd -C "%~dp0." .
if errorlevel 1 goto fail
copy /y "settings.txt" "%SETS%" >nul
echo.
echo  2/3 Копирую на сервер. Спросит пароль root.
echo      Пароль при вводе не виден — это нормально. Вставить скопированный пароль: правая кнопка мыши.
scp %SSHOPT% "%PACK%" "%SETS%" root@%IP%:/root/
if errorlevel 1 goto fail
del /q "%SETS%" 2>nul
echo.
echo  3/3 Устанавливаю ^(первый раз 10–20 минут^). Пароль root спросят ещё раз.
echo      Если окно закроется или пропадёт интернет — установка на сервере продолжится:
echo      просто запусти этот файл снова, он покажет, как она идёт.
ssh -t %SSHOPT% root@%IP% "set -e; chmod 600 /root/reellab-settings.txt; D=/root/reellab-$(date +%%Y%%m%%d-%%H%%M%%S); mkdir -p $D/reellab-server; tar -xzf /root/reellab-upload.tar.gz -C $D/reellab-server --no-same-owner --no-same-permissions --warning=no-unknown-keyword; sed -i 's/\r$//' $D/reellab-server/deploy/*.sh; bash $D/reellab-server/deploy/remote-install.sh"
if errorlevel 1 goto fail
del /q "%PACK%" 2>nul
echo.
echo  Готово. Открой своего бота в Telegram и нажми /start.
echo  Проверить сервер позже — «ПРОВЕРИТЬ СЕРВЕР.cmd».
pause
exit /b 0

:fail
del /q "%SETS%" 2>nul
echo.
echo  Что-то пошло не так. Сфотографируй это окно — по тексту выше видно, на каком шаге.
echo  Частые причины: неверный IP или пароль root ^(пароль вводится в английской раскладке^),
echo  сервер ещё создаётся, нет интернета. Можно просто запустить этот файл ещё раз.
pause
exit /b 1
