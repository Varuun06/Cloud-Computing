"""Sample data loaded the first time the service starts (when no data file exists)."""

_TS = "2026-07-01T09:00:00+00:00"

SEED_COURSES = [
    {"id": "C101", "code": "IT1701", "title": "Cloud and Distributed Computing", "credits": 3, "department": "IT",
     "semester": 7, "instructor": "Dr. R. Priyadharshini", "capacity": 60, "enrolled_students": ["S1001", "S1002"],
     "created_at": _TS, "updated_at": _TS},
    {"id": "C102", "code": "IT1702", "title": "Machine Learning Techniques", "credits": 3, "department": "IT",
     "semester": 7, "instructor": "Dr. K. Arun", "capacity": 60, "enrolled_students": ["S1002"],
     "created_at": _TS, "updated_at": _TS},
    {"id": "C103", "code": "CS1704", "title": "Cryptography and Network Security", "credits": 4, "department": "CSE",
     "semester": 7, "instructor": "Dr. M. Sanjay", "capacity": 2, "enrolled_students": ["S1003"],
     "created_at": _TS, "updated_at": _TS},
]
