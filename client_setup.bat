@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ==========================================
echo SYMBIOSIS - Client setup
echo ==========================================
echo.

set "PYTHON_CMD="
where py >nul 2>&1
if not errorlevel 1 set "PYTHON_CMD=py -3"
if not defined PYTHON_CMD (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD (
    echo ERROR: Python 3.10 or newer was not found.
    echo Download: https://www.python.org/downloads/
    goto failed
)

for /f "tokens=2" %%V in ('%PYTHON_CMD% --version 2^>^&1') do set "PYTHON_VERSION=%%V"
echo Found Python %PYTHON_VERSION%

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 goto failed
)

set "VENV_PYTHON=.venv\Scripts\python.exe"
echo Upgrading pip...
"%VENV_PYTHON%" -m pip install --upgrade pip
if errorlevel 1 goto failed

echo Installing all application packages...
"%VENV_PYTHON%" -m pip install -r requirements.txt
if errorlevel 1 goto failed

if not exist ".env" if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo Created .env from .env.example. Add API keys before online features.
)

if not exist "models\best.pt" (
    echo WARNING: models\best.pt is missing. Add trained model before detection.
)

echo.
echo Setup complete.
echo Start application with startall.bat
pause
exit /b 0

:failed
echo.
echo Setup failed. Check internet access and error output above.
pause
exit /b 1
