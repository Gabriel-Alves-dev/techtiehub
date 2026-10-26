@echo off
rem Liga este PC ao hub (local ou na nuvem). Na primeira vez, pareie com o comando
rem mostrado no hub em PC - Conectar um PC; depois basta dar dois cliques aqui.
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
node conector.js
pause
