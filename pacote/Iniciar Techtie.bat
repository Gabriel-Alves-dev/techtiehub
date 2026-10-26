@echo off
rem Techtie Hub - conector deste PC. Dois cliques e pronto:
rem baixa o Node.js portatil se faltar, instala, pareia, confere o login do Claude e conecta.
title Techtie Hub - conector
cd /d "%~dp0"

if not exist "conector.js" (
  echo Extraia o arquivo .zip para uma pasta antes de abrir este arquivo.
  goto fim
)

where node >nul 2>nul
if errorlevel 1 (
  if not exist "runtime\node.exe" (
    echo Baixando o Node.js portatil ^(so na primeira vez, nada e instalado no Windows^)...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0baixar-node.ps1"
    if errorlevel 1 goto erro
  )
  set "PATH=%~dp0runtime;%PATH%"
)

if not exist "node_modules\@anthropic-ai\claude-agent-sdk" (
  echo Instalando o conector ^(so na primeira vez, leva um minuto^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto erro
)

node preparar.js
if errorlevel 1 goto erro

echo.
echo Conector ligado. Deixe esta janela aberta (pode minimizar) enquanto usa o hub.
echo.
node conector.js
goto fim

:erro
echo.
echo Algo deu errado. Veja a mensagem acima e tente abrir este arquivo de novo.

:fim
pause
