"""Request/response models. Pydantic validates every request automatically and
returns HTTP 422 with field-level error details when the input is invalid."""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

EMAIL_PATTERN = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"


class StudentBase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class StudentCreate(StudentBase):
    register_number: str = Field(pattern=r"^\d{12}$", examples=["312222205099"])
    name: str = Field(min_length=1, max_length=100, examples=["Varuun K"])
    email: str = Field(pattern=EMAIL_PATTERN, examples=["varuun2210@ssn.edu.in"])
    department: str = Field(min_length=1, max_length=50, examples=["IT"])
    year: int = Field(ge=1, le=4, examples=[4])
    cgpa: Optional[float] = Field(default=None, ge=0, le=10, examples=[8.7])
    phone: Optional[str] = Field(default=None, pattern=r"^\+?\d{10,13}$", examples=["9876543210"])


class StudentUpdate(StudentBase):
    """All fields optional - only the supplied fields are changed."""
    register_number: Optional[str] = Field(default=None, pattern=r"^\d{12}$")
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    email: Optional[str] = Field(default=None, pattern=EMAIL_PATTERN)
    department: Optional[str] = Field(default=None, min_length=1, max_length=50)
    year: Optional[int] = Field(default=None, ge=1, le=4)
    cgpa: Optional[float] = Field(default=None, ge=0, le=10)
    phone: Optional[str] = Field(default=None, pattern=r"^\+?\d{10,13}$")


class Student(StudentCreate):
    model_config = ConfigDict(extra="ignore")
    id: str
    created_at: str
    updated_at: str


class StudentList(BaseModel):
    count: int
    data: List[Student]


class DeleteResponse(BaseModel):
    message: str
    data: Student
