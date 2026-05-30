@echo off
cd /d "%~dp0"

echo ============================================
echo  YouTubeAuto Server Killer
echo  Kills youtubeauto servers on ports 3001/5173
echo  Safely skips Codebuff, Freebuff, and OpenCode processes
echo ============================================
echo

:: --- Kill by port: Backend (3001) ---
echo [1/2] Looking for backend on port 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":3001 "') do (
    if not "%%a"=="" (
        powershell -NoProfile -Command "exit (if((Get-CimInstance Win32_Process -Filter 'ProcessId = %%a').CommandLine -match '(?i)codebuff|freebuff|opencode'){0}else{1})" 2>nul
        if errorlevel 1 (
            echo  -> Killing PID %%a (port 3001)
            taskkill /F /PID %%a >nul 2>&1
        ) else (
            echo  -> Skipping PID %%a (port 3001 - Codebuff/Freebuff/OpenCode)
        )
    )
)
timeout /t 1 /nobreak >nul

:: --- Kill by port: Launcher / Vite (5173) ---
echo [2/2] Looking for launcher on port 5173...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":5173 "') do (
    if not "%%a"=="" (
        powershell -NoProfile -Command "exit (if((Get-CimInstance Win32_Process -Filter 'ProcessId = %%a').CommandLine -match '(?i)codebuff|freebuff|opencode'){0}else{1})" 2>nul
        if errorlevel 1 (
            echo  -> Killing PID %%a (port 5173)
            taskkill /F /PID %%a >nul 2>&1
        ) else (
            echo  -> Skipping PID %%a (port 5173 - Codebuff/Freebuff/OpenCode)
        )
    )
)

echo.
echo ============================================
echo  Done! Servers on ports 3001 and 5173 killed.
echo  (Codebuff, Freebuff, and OpenCode processes were skipped)
echo  Verify with:  netstat -ano ^| findstr ":3001 :5173"
echo ============================================
timeout /t 3 /nobreak >nul
