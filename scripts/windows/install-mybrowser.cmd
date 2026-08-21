@echo off
setlocal

set "MYBROWSER_SCRIPT=%~dp0install-mybrowser.ps1"
if not exist "%MYBROWSER_SCRIPT%" (
  echo ERROR: install-mybrowser.ps1 must be next to this CMD file.
  exit /b 1
)

where powershell.exe >nul 2>nul
if not errorlevel 1 goto windows_powershell

where pwsh.exe >nul 2>nul
if not errorlevel 1 goto powershell_7

echo ERROR: Windows PowerShell 5.1 or PowerShell 7 is required.
exit /b 1

:windows_powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MYBROWSER_SCRIPT%" %*
exit /b %errorlevel%

:powershell_7
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MYBROWSER_SCRIPT%" %*
exit /b %errorlevel%
