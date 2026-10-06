"""Course Service - an independent REST microservice for managing courses.

Run:  uvicorn app.main:app --port 8002      (from the course-service folder)
Docs: http://localhost:8002/docs
"""
import logging
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .schemas import (
    Course, CourseCreate, CourseList, CourseUpdate, DeleteResponse,
    EnrollmentList, EnrollmentRequest, EnrollmentResponse,
)
from .seed import SEED_COURSES
from .store import JsonStore
from .student_client import StudentClient, StudentServiceUnavailable

SERVICE_NAME = "course-service"
DEFAULT_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "courses.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger(SERVICE_NAME)


def with_seats(course: dict) -> dict:
    course.setdefault("enrolled_students", [])
    course["seats_available"] = course["capacity"] - len(course["enrolled_students"])
    return course


def create_app(store: Optional[JsonStore] = None, student_client: Optional[StudentClient] = None) -> FastAPI:
    app = FastAPI(
        title="Course Service",
        version="1.0.0",
        description="Independent microservice that manages courses and enrollments. Owns its own data store.",
    )
    app.state.store = store or JsonStore(
        Path(os.getenv("DATA_FILE", DEFAULT_DATA_FILE)), prefix="C", seed=SEED_COURSES, start_at=101
    )
    app.state.student_client = student_client or StudentClient(
        # 127.0.0.1 rather than localhost avoids a ~2s IPv6 fallback delay on Windows
        os.getenv("STUDENT_SERVICE_URL", "http://127.0.0.1:8001")
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

    def get_or_404(course_id: str) -> dict:
        course = db().get(course_id)
        if course is None:
            raise HTTPException(404, f"Course {course_id} not found")
        return course

    def ensure_unique_code(code: Optional[str], exclude_id: Optional[str] = None) -> None:
        if code and any(c["code"] == code and c["id"] != exclude_id for c in db().all()):
            raise HTTPException(409, f"Course code {code} already exists")

    @app.get("/", tags=["Info"])
    def root():
        return {"service": SERVICE_NAME, "docs": "/docs", "health": "/health", "api": "/api/courses"}

    @app.get("/health", tags=["Info"])
    def health():
        return {
            "service": SERVICE_NAME,
            "status": "UP",
            "uptime_seconds": round(time.time() - app.state.started, 1),
            "total_courses": len(db().all()),
        }

    # ---------------- Course CRUD ----------------

    @app.get("/api/courses", response_model=CourseList, tags=["Courses"])
    def list_courses(
        department: Optional[str] = Query(None, examples=["IT"]),
        semester: Optional[int] = Query(None, ge=1, le=8),
        search: Optional[str] = Query(None, description="Matches title or code"),
    ):
        courses = db().all()
        if department:
            courses = [c for c in courses if c["department"].lower() == department.lower()]
        if semester:
            courses = [c for c in courses if c["semester"] == semester]
        if search:
            q = search.lower()
            courses = [c for c in courses if q in c["title"].lower() or q in c["code"].lower()]
        return {"count": len(courses), "data": [with_seats(c) for c in courses]}

    @app.get("/api/courses/{course_id}", response_model=Course, tags=["Courses"])
    def get_course(course_id: str):
        return with_seats(get_or_404(course_id))

    @app.post("/api/courses", response_model=Course, status_code=201, tags=["Courses"])
    def create_course(payload: CourseCreate, response: Response):
        ensure_unique_code(payload.code)
        course = db().insert({**payload.model_dump(), "enrolled_students": []})
        response.headers["Location"] = f"/api/courses/{course['id']}"
        return with_seats(course)

    @app.put("/api/courses/{course_id}", response_model=Course, tags=["Courses"])
    def update_course(course_id: str, payload: CourseUpdate):
        course = get_or_404(course_id)
        changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
        if not changes:
            raise HTTPException(400, "Provide at least one field to update")
        ensure_unique_code(changes.get("code"), exclude_id=course_id)
        if "capacity" in changes and changes["capacity"] < len(course["enrolled_students"]):
            raise HTTPException(
                409, f"Capacity cannot be below the {len(course['enrolled_students'])} students already enrolled"
            )
        return with_seats(db().update(course_id, changes))

    @app.delete("/api/courses/{course_id}", response_model=DeleteResponse, tags=["Courses"])
    def delete_course(course_id: str):
        removed = db().delete(course_id)
        if removed is None:
            raise HTTPException(404, f"Course {course_id} not found")
        return {"message": f"Course {course_id} deleted", "data": with_seats(removed)}

    # ---------------- Enrollments ----------------

    @app.get("/api/courses/{course_id}/enrollments", response_model=EnrollmentList, tags=["Enrollments"])
    def list_enrollments(course_id: str):
        course = get_or_404(course_id)
        ids = course["enrolled_students"]
        return {"course_id": course_id, "course_code": course["code"], "count": len(ids), "student_ids": ids}

    @app.post("/api/courses/{course_id}/enrollments", response_model=EnrollmentResponse, status_code=201,
              tags=["Enrollments"])
    def enroll_student(course_id: str, payload: EnrollmentRequest):
        course = get_or_404(course_id)
        student_id = payload.student_id
        if student_id in course["enrolled_students"]:
            raise HTTPException(409, f"Student {student_id} is already enrolled in {course['code']}")
        if len(course["enrolled_students"]) >= course["capacity"]:
            raise HTTPException(409, f"Course {course['code']} is full")

        # Inter-service call over REST to validate the student
        try:
            student = app.state.student_client.get_student(student_id)
        except StudentServiceUnavailable as exc:
            raise HTTPException(503, f"Cannot verify student right now - {exc}")
        if student is None:
            raise HTTPException(404, f"Student {student_id} does not exist in the Student Service")

        updated = with_seats(db().update(course_id, {"enrolled_students": course["enrolled_students"] + [student_id]}))
        return {
            "message": f"{student.get('name', student_id)} enrolled in {updated['code']}",
            "course_id": course_id,
            "student_id": student_id,
            "student_name": student.get("name"),
            "enrolled_count": len(updated["enrolled_students"]),
            "seats_available": updated["seats_available"],
        }

    @app.delete("/api/courses/{course_id}/enrollments/{student_id}", response_model=EnrollmentResponse,
                tags=["Enrollments"])
    def unenroll_student(course_id: str, student_id: str):
        course = get_or_404(course_id)
        if student_id not in course["enrolled_students"]:
            raise HTTPException(404, f"Student {student_id} is not enrolled in {course['code']}")
        remaining = [s for s in course["enrolled_students"] if s != student_id]
        updated = with_seats(db().update(course_id, {"enrolled_students": remaining}))
        return {
            "message": f"Student {student_id} removed from {updated['code']}",
            "course_id": course_id,
            "student_id": student_id,
            "enrolled_count": len(remaining),
            "seats_available": updated["seats_available"],
        }

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8002)))
