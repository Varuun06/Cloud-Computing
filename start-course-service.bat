@echo off
title Course Service - port 8002
cd /d "%~dp0course-service"
"%~dp0.venv\Scripts\python.exe" -m uvicorn app.main:app --port 8002
pause
