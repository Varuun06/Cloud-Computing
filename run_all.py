"""Starts both microservices as two separate OS processes (Ctrl+C stops both).

    python run_all.py

For the independence demo, prefer starting each service in its own terminal
(see README) so you can stop one while the other keeps running.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVICES = [("student-service", 8001), ("course-service", 8002)]

procs = []
try:
    for name, port in SERVICES:
        print(f"Starting {name} on http://localhost:{port}  (docs: http://localhost:{port}/docs)")
        procs.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
            cwd=ROOT / name,
        ))
    for p in procs:
        p.wait()
except KeyboardInterrupt:
    print("\nStopping services...")
finally:
    for p in procs:
        p.terminate()
