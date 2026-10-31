@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found. Installing prerequisites first...
    call "%~dp0install_prerequisites.bat"
    if errorlevel 1 (
        echo.
        echo ERROR: Prerequisite installation failed.
        pause
        exit /b 1
    )
)

echo ==========================================
echo MUSA - Starting application
echo ==========================================
echo.
echo Open http://127.0.0.1:5000 in your browser.
echo Press Ctrl+C to stop the server.
echo.

".venv\Scripts\python.exe" app.py

echo.
echo MUSA has stopped.
pause
