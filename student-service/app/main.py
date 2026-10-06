"""Student Service - an independent REST microservice for managing students.

Run:  uvicorn app.main:app --port 8001      (from the student-service folder)
Docs: http://localhost:8001/docs
"""
import logging
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .schemas import DeleteResponse, Student, StudentCreate, StudentList, StudentUpdate
from .seed import SEED_STUDENTS
from .store import JsonStore

SERVICE_NAME = "student-service"
DEFAULT_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "students.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger(SERVICE_NAME)


def create_app(store: Optional[JsonStore] = None) -> FastAPI:
    app = FastAPI(
        title="Student Service",
        version="1.0.0",
        description="Independent microservice that manages student records. Owns its own data store.",
    )
    app.state.store = store or JsonStore(
        Path(os.getenv("DATA_FILE", DEFAULT_DATA_FILE)), prefix="S", seed=SEED_STUDENTS, start_at=1001
    )
    app.state.started = time.time()

    @app.middleware("http")
    async def add_service_headers(request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Service-Name"] = SERVICE_NAME
        response.headers["X-Response-Time"] = f"{elapsed_ms:.1f}ms"
        log.info("%s %s -> %s (%.1fms)", request.method, request.url.path, response.status_code, elapsed_ms)
        return response

    def db() -> JsonStore:
        return app.state.store

    def find_conflict(data: dict, exclude_id: Optional[str] = None) -> Optional[dict]:
        for s in db().all():
            if s["id"] == exclude_id:
                continue
            if data.get("register_number") and s["register_number"] == data["register_number"]:
                return s
            if data.get("email") and s["email"] == data["email"]:
                return s
        return None

    def get_or_404(student_id: str) -> dict:
        student = db().get(student_id)
        if student is None:
            raise HTTPException(status_code=404, detail=f"Student {student_id} not found")
        return student

    @app.get("/", tags=["Info"])
    def root():
        return {"service": SERVICE_NAME, "docs": "/docs", "health": "/health", "api": "/api/students"}

    @app.get("/health", tags=["Info"])
    def health():
        return {
            "service": SERVICE_NAME,
            "status": "UP",
            "uptime_seconds": round(time.time() - app.state.started, 1),
            "total_students": len(db().all()),
        }

    @app.get("/api/students", response_model=StudentList, tags=["Students"])
    def list_students(
        department: Optional[str] = Query(None, examples=["IT"]),
        year: Optional[int] = Query(None, ge=1, le=4),
        search: Optional[str] = Query(None, description="Matches name or register number"),
    ):
        students = db().all()
        if department:
            students = [s for s in students if s["department"].lower() == department.lower()]
        if year:
            students = [s for s in students if s["year"] == year]
        if search:
            q = search.lower()
            students = [s for s in students if q in s["name"].lower() or q in s["register_number"]]
        return {"count": len(students), "data": students}

    @app.get("/api/students/{student_id}", response_model=Student, tags=["Students"])
    def get_student(student_id: str):
        return get_or_404(student_id)

    @app.post("/api/students", response_model=Student, status_code=201, tags=["Students"])
    def create_student(payload: StudentCreate, response: Response):
        data = payload.model_dump()
        data["email"] = data["email"].lower()
        conflict = find_conflict(data)
        if conflict:
            raise HTTPException(409, f"Register number or email already used by student {conflict['id']}")
        student = db().insert(data)
        response.headers["Location"] = f"/api/students/{student['id']}"
        return student

    @app.put("/api/students/{student_id}", response_model=Student, tags=["Students"])
    def update_student(student_id: str, payload: StudentUpdate):
        get_or_404(student_id)
        changes = payload.model_dump(exclude_unset=True)
        # required fields cannot be cleared; optional ones (cgpa, phone) may be set to null
        changes = {k: v for k, v in changes.items() if v is not None or k in ("cgpa", "phone")}
        if not changes:
            raise HTTPException(400, "Provide at least one field to update")
        if changes.get("email"):
            changes["email"] = changes["email"].lower()
        conflict = find_conflict(changes, exclude_id=student_id)
        if conflict:
            raise HTTPException(409, f"Register number or email already used by student {conflict['id']}")
        return db().update(student_id, changes)

    @app.delete("/api/students/{student_id}", response_model=DeleteResponse, tags=["Students"])
    def delete_student(student_id: str):
        removed = db().delete(student_id)
        if removed is None:
            raise HTTPException(404, f"Student {student_id} not found")
        return {"message": f"Student {student_id} deleted", "data": removed}

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8001)))
