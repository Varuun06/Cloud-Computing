"""HTTP client the Course Service uses to verify a student exists before enrolling.

This is the ONLY coupling between the two services, and it happens over REST -
the Course Service never touches the Student Service's data directly. If the
Student Service is down, only enrollment fails (HTTP 503); every other course
endpoint keeps working. That is fault isolation.
"""
from typing import Optional

import httpx


class StudentServiceUnavailable(Exception):
    pass


class StudentClient:
    def __init__(self, base_url: str, timeout: float = 3.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_student(self, student_id: str) -> Optional[dict]:
        """Returns the student dict, or None if the Student Service says 404."""
        try:
            r = httpx.get(f"{self.base_url}/api/students/{student_id}", timeout=self.timeout)
        except httpx.HTTPError as exc:
            raise StudentServiceUnavailable(f"Student Service unreachable at {self.base_url}: {exc.__class__.__name__}")
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise StudentServiceUnavailable(f"Student Service responded with HTTP {r.status_code}")
        return r.json()
