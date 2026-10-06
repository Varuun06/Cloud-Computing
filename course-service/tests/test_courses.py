import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import SEED_COURSES
from app.store import JsonStore
from app.student_client import StudentServiceUnavailable

NEW_COURSE = {
    "code": "IT1705",
    "title": "Internet of Things",
    "credits": 3,
    "department": "IT",
    "semester": 7,
    "instructor": "Dr. S. Meena",
    "capacity": 60,
}


class FakeStudentClient:
    """Stands in for the real Student Service so the Course Service is tested in isolation."""

    def __init__(self, students=None, down=False):
        self.students = students or {}
        self.down = down

    def get_student(self, student_id):
        if self.down:
            raise StudentServiceUnavailable("connection refused")
        return self.students.get(student_id)


def make_client(student_client):
    store = JsonStore(None, prefix="C", seed=SEED_COURSES, start_at=101)  # in-memory
    return TestClient(create_app(store, student_client))


@pytest.fixture
def client():
    return make_client(FakeStudentClient({"S1004": {"id": "S1004", "name": "Divya Lakshmi"}}))


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.headers["X-Service-Name"] == "course-service"


def test_list_and_filter(client):
    assert client.get("/api/courses").json()["count"] == len(SEED_COURSES)
    it = client.get("/api/courses", params={"department": "IT"}).json()
    assert {c["code"] for c in it["data"]} == {"IT1701", "IT1702"}
    assert client.get("/api/courses/C101").json()["seats_available"] == 58


def test_crud_lifecycle(client):
    r = client.post("/api/courses", json=NEW_COURSE)
    assert r.status_code == 201
    course = r.json()
    assert course["id"] == "C104"
    assert course["enrolled_students"] == [] and course["seats_available"] == 60

    r = client.put("/api/courses/C104", json={"instructor": "Dr. P. Kumar", "capacity": 40})
    assert r.json()["instructor"] == "Dr. P. Kumar" and r.json()["seats_available"] == 40

    assert client.delete("/api/courses/C104").status_code == 200
    assert client.get("/api/courses/C104").status_code == 404


def test_validation_and_conflicts(client):
    r = client.post("/api/courses", json={**NEW_COURSE, "code": "bad code", "credits": 9})
    assert r.status_code == 422
    assert {e["loc"][-1] for e in r.json()["detail"]} == {"code", "credits"}

    assert client.post("/api/courses", json={**NEW_COURSE, "code": "IT1701"}).status_code == 409
    # C101 already has 2 students enrolled
    assert client.put("/api/courses/C101", json={"capacity": 1}).status_code == 409


def test_enroll_and_unenroll(client):
    r = client.post("/api/courses/C101/enrollments", json={"student_id": "S1004"})
    assert r.status_code == 201
    assert r.json()["student_name"] == "Divya Lakshmi"
    assert r.json()["enrolled_count"] == 3

    assert client.post("/api/courses/C101/enrollments", json={"student_id": "S1004"}).status_code == 409
    assert "S1004" in client.get("/api/courses/C101/enrollments").json()["student_ids"]

    assert client.delete("/api/courses/C101/enrollments/S1004").status_code == 200
    assert client.delete("/api/courses/C101/enrollments/S1004").status_code == 404


def test_enroll_unknown_student(client):
    r = client.post("/api/courses/C101/enrollments", json={"student_id": "S9999"})
    assert r.status_code == 404


def test_course_full():
    c = make_client(FakeStudentClient({"S1004": {"id": "S1004", "name": "D"}, "S1005": {"id": "S1005", "name": "E"}}))
    assert c.post("/api/courses/C103/enrollments", json={"student_id": "S1004"}).status_code == 201  # 2/2
    assert c.post("/api/courses/C103/enrollments", json={"student_id": "S1005"}).status_code == 409


def test_fault_isolation_when_student_service_down():
    c = make_client(FakeStudentClient(down=True))
    # enrollment needs the Student Service -> 503 ...
    assert c.post("/api/courses/C101/enrollments", json={"student_id": "S1004"}).status_code == 503
    # ... but everything else in the Course Service keeps working
    assert c.get("/api/courses").status_code == 200
    assert c.post("/api/courses", json=NEW_COURSE).status_code == 201
