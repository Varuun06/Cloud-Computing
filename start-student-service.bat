@echo off
title Student Service - port 8001
cd /d "%~dp0student-service"
"%~dp0.venv\Scripts\python.exe" -m uvicorn app.main:app --port 8001
pause
