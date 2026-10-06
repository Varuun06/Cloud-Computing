import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed import SEED_STUDENTS
from app.store import JsonStore

NEW_STUDENT = {
    "register_number": "312222205099",
    "name": "Test Student",
    "email": "Test.Student@ssn.edu.in",
    "department": "IT",
    "year": 4,
    "cgpa": 8.5,
}


@pytest.fixture
def client():
    store = JsonStore(None, prefix="S", seed=SEED_STUDENTS, start_at=1001)  # in-memory
    return TestClient(create_app(store))


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "UP"
    assert r.headers["X-Service-Name"] == "student-service"


def test_list_and_filter(client):
    assert client.get("/api/students").json()["count"] == len(SEED_STUDENTS)
    it = client.get("/api/students", params={"department": "it", "year": 4}).json()
    assert {s["id"] for s in it["data"]} == {"S1001", "S1002"}
    assert client.get("/api/students", params={"search": "priya"}).json()["data"][0]["id"] == "S1002"


def test_crud_lifecycle(client):
    r = client.post("/api/students", json=NEW_STUDENT)
    assert r.status_code == 201
    student = r.json()
    assert student["id"] == "S1005"
    assert student["email"] == "test.student@ssn.edu.in"
    assert r.headers["Location"] == "/api/students/S1005"

    assert client.get("/api/students/S1005").json()["name"] == "Test Student"

    r = client.put("/api/students/S1005", json={"cgpa": 9.1, "year": 4})
    assert r.status_code == 200
    assert r.json()["cgpa"] == 9.1
    assert r.json()["name"] == "Test Student"  # untouched fields are kept

    assert client.delete("/api/students/S1005").status_code == 200
    assert client.get("/api/students/S1005").status_code == 404


def test_validation_errors(client):
    bad = {**NEW_STUDENT, "email": "not-an-email", "year": 7, "register_number": "123"}
    r = client.post("/api/students", json=bad)
    assert r.status_code == 422
    bad_fields = {e["loc"][-1] for e in r.json()["detail"]}
    assert bad_fields == {"email", "year", "register_number"}

    assert client.post("/api/students", json={"name": "Only name"}).status_code == 422
    assert client.put("/api/students/S1001", json={}).status_code == 400


def test_duplicates_rejected(client):
    dup = {**NEW_STUDENT, "register_number": "312222205001"}  # belongs to S1001
    assert client.post("/api/students", json=dup).status_code == 409
    assert client.put("/api/students/S1002", json={"email": "aarav2210@ssn.edu.in"}).status_code == 409


def test_not_found(client):
    assert client.get("/api/students/S9999").status_code == 404
    assert client.put("/api/students/S9999", json={"cgpa": 9.0}).status_code == 404
    assert client.delete("/api/students/S9999").status_code == 404
