@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" server.py
) else (
  py -3.12 server.py 2>nul || python server.py
)
