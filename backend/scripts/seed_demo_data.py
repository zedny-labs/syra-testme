"""Seed demo data for SYRA LMS."""
import logging
import sys
import os

# Add backend to path so imports work when run as script
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session

from src.app.core.security import hash_password
from src.app.db.session import SessionLocal
from src.app.db.base import Base
from src.app.db.session import engine
from src.app.models import (
    User, RoleEnum, Course, Node, Exam, ExamType, ExamStatus, CourseStatus,
    Question, Category, CategoryType, GradingScale, QuestionPool, Schedule,
    AccessMode,
)

logger = logging.getLogger(__name__)


def seed():
    # Create tables if they don't exist
    Base.metadata.create_all(bind=engine)

    db: Session = SessionLocal()
    try:
        if db.query(User).count() > 0:
            logger.info("Data already present, skipping seeds")
            return

        # --- Users ---
        admin = User(
            email="admin@example.com", name="Admin User", user_id="ADM001",
            role=RoleEnum.ADMIN, hashed_password=hash_password("Admin1234!"),
        )
        instructor = User(
            email="instructor@example.com", name="Dr. Sarah Ahmed", user_id="INS001",
            role=RoleEnum.INSTRUCTOR, hashed_password=hash_password("Instructor1234!"),
        )
        learner1 = User(
            email="student1@example.com", name="Omar Hassan", user_id="STU001",
            role=RoleEnum.LEARNER, hashed_password=hash_password("Student1234!"),
        )
        learner2 = User(
            email="student2@example.com", name="Fatima Ali", user_id="STU002",
            role=RoleEnum.LEARNER, hashed_password=hash_password("Student1234!"),
        )
        db.add_all([admin, instructor, learner1, learner2])
        db.flush()

        # --- Category ---
        cat_test = Category(name="Final Exams", type=CategoryType.TEST, description="End-of-semester assessments", created_by_id=instructor.id)
        cat_quiz = Category(name="Quizzes", type=CategoryType.TEST, description="Quick knowledge checks", created_by_id=instructor.id)
        cat_survey = Category(name="Course Feedback", type=CategoryType.SURVEY, description="Student satisfaction surveys", created_by_id=instructor.id)
        db.add_all([cat_test, cat_quiz, cat_survey])
        db.flush()

        # --- Grading Scale ---
        scale = GradingScale(
            name="Standard Letter Grade",
            created_by_id=instructor.id,
            labels=[
                {"label": "A+", "min_score": 95, "max_score": 100},
                {"label": "A", "min_score": 90, "max_score": 94.99},
                {"label": "B+", "min_score": 85, "max_score": 89.99},
                {"label": "B", "min_score": 80, "max_score": 84.99},
                {"label": "C+", "min_score": 75, "max_score": 79.99},
                {"label": "C", "min_score": 70, "max_score": 74.99},
                {"label": "D", "min_score": 60, "max_score": 69.99},
                {"label": "F", "min_score": 0, "max_score": 59.99},
            ],
        )
        db.add(scale)
        db.flush()

        # --- Course ---
        course = Course(
            title="Introduction to Computer Science",
            description="Covers fundamental CS concepts including algorithms, data structures, and programming.",
            status=CourseStatus.PUBLISHED,
            created_by_id=instructor.id,
        )
        db.add(course)
        db.flush()

        # --- Nodes ---
        node1 = Node(course_id=course.id, title="Module 1: Programming Basics", order=1)
        node2 = Node(course_id=course.id, title="Module 2: Data Structures", order=2)
        node3 = Node(course_id=course.id, title="Module 3: Algorithms", order=3)
        db.add_all([node1, node2, node3])
        db.flush()

        # --- Exam with proctoring ---
        exam1 = Exam(
            node_id=node1.id, title="Programming Fundamentals Exam", type=ExamType.MCQ,
            status=ExamStatus.OPEN, time_limit=30, max_attempts=3, passing_score=70.0,
            category_id=cat_test.id, grading_scale_id=scale.id, created_by_id=instructor.id,
            proctoring_config={
                "face_detection": True, "audio_detection": True, "object_detection": True,
                "eye_tracking": True, "mouth_detection": True,
                "access_mode": "RESTRICTED",
            },
        )
        exam2 = Exam(
            node_id=node2.id, title="Data Structures Quiz", type=ExamType.MCQ,
            status=ExamStatus.OPEN, time_limit=15, max_attempts=3, passing_score=60.0,
            category_id=cat_quiz.id, grading_scale_id=scale.id, created_by_id=instructor.id,
            proctoring_config={"face_detection": True, "audio_detection": False, "object_detection": False},
        )
        exam3 = Exam(
            node_id=node3.id, title="Algorithm Analysis", type=ExamType.TEXT,
            status=ExamStatus.OPEN, time_limit=45, max_attempts=3, passing_score=50.0,
            category_id=cat_test.id, created_by_id=instructor.id,
        )
        db.add_all([exam1, exam2, exam3])
        db.flush()

        # --- Questions for Exam 1 ---
        questions = [
            Question(exam_id=exam1.id, text="What is the output of print(2 ** 3)?", type=ExamType.MCQ,
                     options=["6", "8", "9", "5"], correct_answer="B", points=2.0, order=1),
            Question(exam_id=exam1.id, text="Which keyword is used to define a function in Python?", type=ExamType.MCQ,
                     options=["func", "def", "function", "define"], correct_answer="B", points=2.0, order=2),
            Question(exam_id=exam1.id, text="What data type is the result of: 10 / 3?", type=ExamType.MCQ,
                     options=["int", "float", "str", "bool"], correct_answer="B", points=2.0, order=3),
            Question(exam_id=exam1.id, text="Which of these is a mutable data type?", type=ExamType.MCQ,
                     options=["tuple", "string", "list", "int"], correct_answer="C", points=2.0, order=4),
            Question(exam_id=exam1.id, text="What does the 'len()' function return?", type=ExamType.MCQ,
                     options=["The type", "The length", "The sum", "The max"], correct_answer="B", points=2.0, order=5),
        ]
        db.add_all(questions)

        # --- Questions for Exam 2 ---
        q2_list = [
            Question(exam_id=exam2.id, text="What is the time complexity of binary search?", type=ExamType.MCQ,
                     options=["O(n)", "O(log n)", "O(n^2)", "O(1)"], correct_answer="B", points=1.0, order=1),
            Question(exam_id=exam2.id, text="Which data structure uses FIFO?", type=ExamType.MCQ,
                     options=["Stack", "Queue", "Tree", "Graph"], correct_answer="B", points=1.0, order=2),
            Question(exam_id=exam2.id, text="A stack uses which principle?", type=ExamType.MCQ,
                     options=["FIFO", "LIFO", "Random", "Priority"], correct_answer="B", points=1.0, order=3),
        ]
        db.add_all(q2_list)

        # --- Question Pool ---
        pool = QuestionPool(name="General CS Pool", description="Reusable questions for CS courses", created_by_id=instructor.id)
        db.add(pool)
        db.flush()
        pool_q = Question(exam_id=exam1.id, text="What is recursion?", type=ExamType.MCQ,
                          options=["A loop", "A function calling itself", "A variable", "A class"],
                          correct_answer="B", points=1.0, order=6, pool_id=pool.id)
        db.add(pool_q)

        # --- Schedules ---
        now = datetime.now(timezone.utc)
        sched1 = Schedule(
            exam_id=exam1.id, user_id=learner1.id,
            scheduled_at=now + timedelta(days=2), access_mode=AccessMode.RESTRICTED,
            notes="Proctored exam - ensure camera is working",
        )
        sched2 = Schedule(
            exam_id=exam1.id, user_id=learner2.id,
            scheduled_at=now + timedelta(days=2), access_mode=AccessMode.RESTRICTED,
        )
        sched3 = Schedule(
            exam_id=exam2.id, user_id=learner1.id,
            scheduled_at=now + timedelta(days=5), access_mode=AccessMode.OPEN,
            notes="Open access quiz",
        )
        db.add_all([sched1, sched2, sched3])

        db.commit()
        logger.info("Demo data seeded successfully")
        logger.info("Users: admin@example.com / Admin1234!")
        logger.info("Users: instructor@example.com / Instructor1234!")
        logger.info("Users: student1@example.com / Student1234!")
        logger.info("Users: student2@example.com / Student1234!")
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    seed()
