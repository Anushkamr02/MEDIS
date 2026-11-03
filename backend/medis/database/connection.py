"""
MEDIS Database Connection & Session Management
Supports SQLite (local default) and PostgreSQL.
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# Default to SQLite in project data folder, or use PostgreSQL connection string
DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
os.makedirs(DATA_DIR, exist_ok=True)
SQLITE_PATH = os.path.join(DATA_DIR, "medis.db")

DATABASE_URL = os.environ.get("DATABASE_URL", f"sqlite:///{SQLITE_PATH}")

# SQLite requires check_same_thread=False for multi-threaded apps (FastAPI / Streamlit)
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    echo=False,
    future=True
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI / service dependency to obtain database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Creates all database tables defined in models."""
    from medis.database import models  # noqa: F401
    Base.metadata.create_all(bind=engine)

