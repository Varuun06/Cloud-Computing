"""Request/response models. Pydantic validates every request automatically and
returns HTTP 422 with field-level error details when the input is invalid."""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

CODE_PATTERN = r"^[A-Z]{2,4}\d{3,4}$"  # e.g. IT1701, CS2402


class CourseBase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class CourseCreate(CourseBase):
    code: str = Field(pattern=CODE_PATTERN, examples=["IT1705"])
    title: str = Field(min_length=1, max_length=120, examples=["Internet of Things"])
    credits: int = Field(ge=1, le=5, examples=[3])
    department: str = Field(min_length=1, max_length=50, examples=["IT"])
    semester: int = Field(ge=1, le=8, examples=[7])
    instructor: str = Field(min_length=1, max_length=100, examples=["Dr. S. Meena"])
    capacity: int = Field(ge=1, le=500, examples=[60])


class CourseUpdate(CourseBase):
    """All fields optional - only the supplied fields are changed."""
    code: Optional[str] = Field(default=None, pattern=CODE_PATTERN)
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    credits: Optional[int] = Field(default=None, ge=1, le=5)
    department: Optional[str] = Field(default=None, min_length=1, max_length=50)
    semester: Optional[int] = Field(default=None, ge=1, le=8)
    instructor: Optional[str] = Field(default=None, min_length=1, max_length=100)
    capacity: Optional[int] = Field(default=None, ge=1, le=500)


class Course(CourseCreate):
    model_config = ConfigDict(extra="ignore")
    id: str
    enrolled_students: List[str] = []
    seats_available: int = 0
    created_at: str
    updated_at: str


class CourseList(BaseModel):
    count: int
    data: List[Course]


class DeleteResponse(BaseModel):
    message: str
    data: Course


class EnrollmentRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    student_id: str = Field(min_length=1, examples=["S1001"])


class EnrollmentResponse(BaseModel):
    message: str
    course_id: str
    student_id: str
    student_name: Optional[str] = None
    enrolled_count: int
    seats_available: int


class EnrollmentList(BaseModel):
    course_id: str
    course_code: str
    count: int
    student_ids: List[str]
