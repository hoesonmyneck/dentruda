import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Numeric, Date, DateTime
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://cbdi:cbdi123@localhost:5432/cbdi")

engine = create_engine(DATABASE_URL)


class Base(DeclarativeBase):
    pass


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sicid = Column(BigInteger, index=True)          # SICID — получатель
    rfpm_group = Column(String(500), index=True)    # RFPM_NAME_ГРУПП — вид помощи (группа) — ОСНОВНОЙ
    rfpm_id = Column(String(50))                     # RFPM_ID — сырой код (справочно)
    rfpm_name = Column(String(500))                 # RFPM_NAME — сырое имя (справочно)
    d_naz = Column(Date, index=True)                # D_NAZ — дата назначения
    nsum = Column(Numeric(18, 2))                   # NSUM — сумма
    gender_id = Column(Integer)                     # Пол → 1=М, 2=Ж
    vozrast = Column(Integer)                       # Возраст
    tzhs = Column(String(10))                       # TZHS (A/B)
    kato_region = Column(Integer, index=True)       # КАТО области (11/15/71...)
    kato_raion = Column(Integer, index=True)        # КАТО района (1116/7111...)
    kato_regname = Column(String(300))              # KATO_REGNAME
    kato_rainame = Column(String(300))              # KATO_RAINAME


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    login = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="user")   # 'admin' | 'user'
    created_at = Column(DateTime, default=datetime.utcnow)


class LoginLog(Base):
    """Журнал входов: кто и когда авторизовался на сайте."""
    __tablename__ = "login_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    login = Column(String(100), index=True)
    method = Column(String(20))                                  # 'password'
    ip = Column(String(64))
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
