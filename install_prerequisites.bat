@echo off
setlocal

cd /d "%~dp0"

echo ==========================================
echo MUSA - Installing prerequisites
echo ==========================================

set "PYTHON_CMD="
where py >nul 2>&1
if not errorlevel 1 set "PYTHON_CMD=py -3"

if not defined PYTHON_CMD (
    where python >nul 2>&1
    if not errorlevel 1 set "PYTHON_CMD=python"
)

if not defined PYTHON_CMD (
    echo ERROR: Python was not found.
    echo Install Python 3.10 or newer from https://www.python.org/downloads/
    goto :failed
)

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -m pip --version >nul 2>&1
    if errorlevel 1 (
        echo Existing virtual environment has a broken pip installation.
        echo Recreating the virtual environment...
        rmdir /s /q ".venv"
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %PYTHON_CMD% -m venv .venv
    if errorlevel 1 (
        echo ERROR: Could not create the virtual environment.
        goto :failed
    )
)

echo Upgrading pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo ERROR: Could not upgrade pip.
    goto :failed
)

echo Installing packages from requirements.txt...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo ERROR: Could not install packages from requirements.txt.
    goto :failed
)

echo Installing Ultralytics for model inference...
".venv\Scripts\python.exe" -m pip install ultralytics
if errorlevel 1 (
    echo ERROR: Could not install Ultralytics.
    goto :failed
)

echo.
echo Prerequisites installed successfully.
pause
exit /b 0

:failed
echo.
echo Installation failed. Read the error message above.
echo You can run this file from PowerShell to keep the full output visible.
pause
exit /b 1
