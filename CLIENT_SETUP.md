# SYMBIOSIS Client Setup

Windows setup guide for client machines.

## Requirements

Install before setup:

- Windows 10 or Windows 11, 64-bit
- Python 3.10 or newer: https://www.python.org/downloads/
  - Enable **Add Python to PATH** during installation.
- Git, only when cloning from GitHub: https://git-scm.com/download/win
- Internet connection for first-time package installation, maps, weather, and Groq AI
- At least 8 GB RAM recommended
- Modern browser: Chrome, Edge, or Firefox
- GPU optional. CPU inference works, but GPU is faster.

`models/best.pt` must exist. It is included in the project package. Do not delete or rename it.

## Install

1. Copy or clone project folder to client computer.
2. Open project folder.
3. Double-click `client_setup.bat`.
4. Wait until installation finishes.
5. Copy `.env.example` to `.env`.
6. Add API keys to `.env` if online features are needed.
7. Double-click `startall.bat`.
8. Open `http://127.0.0.1:5000`.

Command-line setup:

```powershell
cd C:\path\to\MUSA
client_setup.bat
```

## Environment configuration

Create `.env` in project root:

```env
GROQ_API_KEY=your_groq_key
GROQ_MODEL=openai/gpt-oss-120b
VISUALCROSSING_API_KEY=your_visualcrossing_key
```

API keys are optional:

- Without `GROQ_API_KEY`, chatbot and AI PDF explanation use offline fallback.
- Without `VISUALCROSSING_API_KEY`, weather fields show unavailable.
- Never send `.env` to GitHub or email.

## Start and stop

Start:

```powershell
startall.bat
```

Stop: press `Ctrl+C` in the server window.

Open from another device on same network:

```text
http://SERVER_IP:5000
```

Windows Firewall may ask permission for Python. Allow private-network access only.

## Troubleshooting

### Python not found

Install Python 3.10+ and enable **Add Python to PATH**, then run `client_setup.bat` again.

### Port 5000 already in use

Close the old SYMBIOSIS server window, or run:

```powershell
Get-NetTCPConnection -LocalPort 5000
```

Use one Flask process only.

### Model not found

Confirm this file exists:

```text
models\best.pt
```

### Package installation fails

Check internet access, then run:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### Online map or weather missing

Check internet access and confirm API keys in `.env`.

## Client data notes

- Uploaded images are stored in `static/uploads`.
- Detection records are stored in local `symbiosis.db`.
- Back up `symbiosis.db` and `static/uploads` before moving or reinstalling the application.
- Do not share exported reports containing precise field coordinates without approval.
