@echo off
cd /d "%~dp0"
rem Defina abaixo uma senha forte para o administrador (obrigatorio para habilitar exclusoes).
set "ADMIN_SENHA=NEWEND1207**"
rem Opcional: para exigir uma senha geral de acesso, preencha a variavel SENHA abaixo.
set "SENHA="
node server.js
pause
