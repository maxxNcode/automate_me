@echo off
echo ============================================
echo  Docker VHDX Compactor
echo  Shrinks the WSL2 VHDX to reclaim disk space
echo ============================================
echo.

:: Must run as admin
openfiles >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo [1/4] Stopping Docker and WSL...
net stop com.docker.service 2>nul
wsl --shutdown
taskkill /f /im "Docker Desktop.exe" 2>nul
taskkill /f /im "com.docker.backend.exe" 2>nul
taskkill /f /im "docker-agent.exe" 2>nul
timeout /t 3 /nobreak >nul

echo [2/4] Compacting VHDX...
set VHDX="C:\Users\Admin\AppData\Local\Docker\wsl\disk\docker_data.vhdx"

echo select vdisk file=%VHDX% > "%TEMP%\compact.txt"
echo attach vdisk readonly >> "%TEMP%\compact.txt"
echo compact vdisk >> "%TEMP%\compact.txt"
echo detach vdisk >> "%TEMP%\compact.txt"
echo exit >> "%TEMP%\compact.txt"

diskpart /s "%TEMP%\compact.txt"
del "%TEMP%\compact.txt" 2>nul

echo [3/4] Checking new size...
for %%F in (%VHDX%) do set VHDX_SIZE=%%~zF
set /a GB_SIZE=%VHDX_SIZE% / 1073741824
echo VHDX is now: %GB_SIZE% GB

echo [4/4] Restarting Docker...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"

echo.
echo ============================================
echo  Done! Docker is starting back up.
echo  Compacted to %GB_SIZE% GB
echo ============================================
timeout /t 10 /nobreak >nul
