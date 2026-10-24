@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
start "" http://localhost:4321
node server.js
