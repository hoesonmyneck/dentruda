import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, Request, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, distinct, or_, and_, cast, Date as SADate
from sqlalchemy import case as sa_case
from sqlalchemy.orm import Session

from database import engine, Payment, User, LoginLog
from load_data import load_data
import ai_data
import auth

# Год, за который строится динамика (в данных полон только он).
DYN_YEAR = 2026


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_data()
    ai_data.load_disability()
    auth.seed_admin()
    yield


app = FastAPI(lifespan=lifespan)

# Публичные пути (сам вход) — без сессии.
_PUBLIC_API = {"/api/auth/login"}


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    """Защита всех /api/* сессионной cookie, кроме входа."""
    path = request.url.path
    if path.startswith("/api/") and path not in _PUBLIC_API:
        token = request.cookies.get(auth.COOKIE_NAME)
        valid = False
        if token:
            try:
                auth._decode_access(token)
                valid = True
            except HTTPException:
                valid = False
        if not valid:
            return JSONResponse({"detail": "Требуется авторизация"}, status_code=401)
    return await call_next(request)


# ─────────────────────────── Auth ───────────────────────────
class LoginBody(BaseModel):
    login: str
    password: str


def _user_out(u: User) -> dict:
    return {"id": u.id, "login": u.login, "role": u.role}


def _client_ip(request: Request):
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.headers.get("x-real-ip") or (request.client.host if request.client else None)


def _record_login(login, method, request: Request):
    try:
        with Session(engine) as db:
            db.add(LoginLog(login=login, method=method, ip=_client_ip(request)))
            db.commit()
    except Exception:
        pass


@app.post("/api/auth/login")
def api_login(body: LoginBody, request: Request):
    login = body.login.strip()
    with Session(engine) as db:
        user = db.query(User).filter(User.login == login).first()
        if not user or not auth.verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
        token = auth.create_access_token(user)
        _record_login(user.login, "password", request)
        resp = JSONResponse(_user_out(user))
        auth.set_auth_cookie(resp, token)
        return resp


@app.get("/api/auth/me")
def api_me(user: User = Depends(auth.current_user)):
    return _user_out(user)


@app.post("/api/auth/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    auth.clear_auth_cookie(resp)
    return resp


# ─────────────────────────── Фильтры ───────────────────────────
def apply_extra_filters(q, gender_filter=None, age_group=None, pay_group=None):
    if pay_group:
        q = q.filter(Payment.rfpm_group == pay_group)
    if gender_filter:
        q = q.filter(Payment.gender_id == int(gender_filter))
    if age_group:
        groups = [g.strip() for g in str(age_group).split(',') if g.strip()]
        conds = []
        for g in groups:
            if g in ('до18', 'до 18'):
                conds.append(Payment.vozrast < 18)
            elif g == '18-39':
                conds.append(and_(Payment.vozrast >= 18, Payment.vozrast < 40))
            elif g == '40-59':
                conds.append(and_(Payment.vozrast >= 40, Payment.vozrast < 60))
            elif g == '60+':
                conds.append(Payment.vozrast >= 60)
        if conds:
            q = q.filter(or_(*conds))
    return q


def build_filter(q, region_id, raion_id, gender_filter=None, age_group=None, pay_group=None):
    if raion_id is not None:
        q = q.filter(Payment.kato_raion == raion_id)
    elif region_id is not None:
        q = q.filter(Payment.kato_region == region_id)
    return apply_extra_filters(q, gender_filter, age_group, pay_group)


def _age_case():
    return sa_case(
        (Payment.vozrast < 18, 'до 18'),
        (Payment.vozrast < 40, '18-39'),
        (Payment.vozrast < 60, '40-59'),
        else_='60+'
    )


# ─────────────────────────── KPI ───────────────────────────
@app.get("/api/kpi")
def kpi(region_id: int = Query(None), raion_id: int = Query(None),
        gender_filter: str = Query(None), age_group: str = Query(None),
        pay_group: str = Query(None)):
    with Session(engine) as db:
        def _mk(gender, age):
            return build_filter(db.query(Payment), region_id, raion_id, gender, age, pay_group)

        base           = _mk(gender_filter, age_group)
        base_no_age    = _mk(gender_filter, None)      # график возрастов
        base_no_gender = _mk(None, age_group)          # пол

        total_sum = base.with_entities(func.sum(Payment.nsum)).scalar() or 0
        recipients = base.with_entities(func.count(distinct(Payment.sicid))).scalar() or 0
        help_type_count = base.with_entities(func.count(distinct(Payment.rfpm_group))).scalar() or 0

        # Пол — по сумме, без фильтра по полу
        male_sum = base_no_gender.filter(Payment.gender_id == 1).with_entities(func.sum(Payment.nsum)).scalar() or 0
        female_sum = base_no_gender.filter(Payment.gender_id == 2).with_entities(func.sum(Payment.nsum)).scalar() or 0

        # Возрастные группы (сумма) с разбивкой по полу — без фильтра по возрасту
        age_expr = _age_case()
        age_rows = (
            base_no_age.with_entities(age_expr, Payment.gender_id, func.sum(Payment.nsum))
            .group_by(age_expr, Payment.gender_id).all()
        )
        age, age_gender = {}, {}
        for grp, gid, s in age_rows:
            s = float(s or 0)
            age[grp] = age.get(grp, 0) + s
            g = age_gender.setdefault(grp, {'m': 0, 'f': 0})
            if gid == 1:   g['m'] += s
            elif gid == 2: g['f'] += s

        # Уровень благосостояния (ЦКС, столбец TZHS: A/B/C/D/E) — сумма с разбивкой по полу
        cks_rows = (
            base.with_entities(func.upper(Payment.tzhs), Payment.gender_id, func.sum(Payment.nsum))
            .group_by(func.upper(Payment.tzhs), Payment.gender_id).all()
        )
        cks, cks_gender = {}, {}
        for lvl, gid, s in cks_rows:
            key = (lvl or '-').strip() or '-'
            s = float(s or 0)
            cks[key] = cks.get(key, 0) + s
            g = cks_gender.setdefault(key, {'m': 0, 'f': 0})
            if gid == 1:   g['m'] += s
            elif gid == 2: g['f'] += s

        return {
            "total_sum": float(total_sum),
            "recipients": recipients,
            "help_type_count": help_type_count,
            "male_sum": float(male_sum),
            "female_sum": float(female_sum),
            "age": age,
            "age_gender": age_gender,
            "cks": cks,
            "cks_gender": cks_gender,
        }


# ─────────────────────── Рейтинг видов помощи ───────────────────────
@app.get("/api/pay-type-stats")
def pay_type_stats(region_id: int = Query(None), raion_id: int = Query(None),
                   gender_filter: str = Query(None), age_group: str = Query(None),
                   pay_group: str = Query(None)):
    """Итоги по группам видов помощи: кол-во строк, получатели, сумма."""
    with Session(engine) as db:
        q = build_filter(
            db.query(
                Payment.rfpm_group,
                func.count(Payment.id).label('cnt'),
                func.count(distinct(Payment.sicid)).label('recipients'),
                func.sum(Payment.nsum).label('total_sum'),
            ),
            region_id, raion_id, gender_filter, age_group, pay_group,
        ).group_by(Payment.rfpm_group).all()

        result = [
            {
                'pay_group': r.rfpm_group or '—',
                'count': r.cnt or 0,
                'recipients': r.recipients or 0,
                'total_sum': round(float(r.total_sum or 0), 2),
            }
            for r in q if r.rfpm_group
        ]
        result.sort(key=lambda x: x['total_sum'], reverse=True)
        return result


# ─────────────────────────── Динамика ───────────────────────────
@app.get("/api/dynamics")
def dynamics(region_id: int = Query(None), raion_id: int = Query(None),
             gender_filter: str = Query(None), age_group: str = Query(None),
             pay_group: str = Query(None)):
    """Помесячная динамика за DYN_YEAR: получатели и сумма."""
    with Session(engine) as db:
        month_expr = func.date_trunc('month', cast(Payment.d_naz, SADate))
        q = build_filter(
            db.query(
                month_expr.label('period'),
                func.count(distinct(Payment.sicid)).label('people'),
                func.sum(Payment.nsum).label('total_sum'),
            ).filter(
                Payment.d_naz.isnot(None),
                func.extract('year', Payment.d_naz) == DYN_YEAR,
            ),
            region_id, raion_id, gender_filter, age_group, pay_group,
        )
        rows = q.group_by(month_expr).order_by(month_expr).all()
        return [
            {
                'period': r.period.strftime('%Y-%m-%d') if hasattr(r.period, 'strftime') else str(r.period)[:10],
                'people': r.people or 0,
                'total_sum': float(r.total_sum or 0),
            }
            for r in rows if r.period is not None
        ]


# ─────────────────────── Регионы / районы ───────────────────────
@app.get("/api/regions")
def regions(gender_filter: str = Query(None), age_group: str = Query(None), pay_group: str = Query(None)):
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.kato_region,
            Payment.kato_regname,
            func.count(Payment.id).label("count"),
            func.sum(Payment.nsum).label("total_sum"),
            func.count(distinct(Payment.sicid)).label("recipients"),
        ), gender_filter, age_group, pay_group).group_by(
            Payment.kato_region, Payment.kato_regname).all()
        return [
            {
                "id_reg": r.kato_region,
                "name": r.kato_regname,
                "count": r.count,
                "total_sum": float(r.total_sum or 0),
                "recipients": r.recipients,
            }
            for r in rows if r.kato_region is not None
        ]


@app.get("/api/analytics")
def analytics(dim: str = Query("paytype"), region_id: int = Query(None), raion_id: int = Query(None),
              gender_filter: str = Query(None), age_group: str = Query(None), pay_group: str = Query(None)):
    """Таблица аналитики: строки — виды помощи / регионы / районы.
    По каждой строке: общая выплата (кол-во + сумма) и разбивка по ЦКС (A–E): кол-во + сумма."""
    with Session(engine) as db:
        cnt = func.count(Payment.id)
        summ = func.sum(Payment.nsum)
        tz = func.upper(Payment.tzhs)
        if dim == "region":
            kid, kname = Payment.kato_region, Payment.kato_regname
            q = apply_extra_filters(
                db.query(kid, kname, tz, cnt, summ), gender_filter, age_group, pay_group)
            group_cols = [kid, kname, tz]
        elif dim == "raion":
            kid, kname = Payment.kato_raion, Payment.kato_rainame
            q = apply_extra_filters(
                db.query(kid, kname, tz, cnt, summ).filter(Payment.kato_region == region_id),
                gender_filter, age_group, pay_group)
            group_cols = [kid, kname, tz]
        else:  # paytype
            kg = Payment.rfpm_group
            q = build_filter(db.query(kg, tz, cnt, summ), region_id, raion_id,
                             gender_filter, age_group, pay_group)
            group_cols = [kg, tz]
        rows = q.group_by(*group_cols).all()

        items = {}
        for r in rows:
            if dim == "paytype":
                kid_v = kname_v = r[0]; tzv, c, s = r[1], r[2], r[3]
            else:
                kid_v, kname_v, tzv, c, s = r[0], r[1], r[2], r[3], r[4]
            if kid_v is None:
                continue
            it = items.setdefault(kid_v, {"id": kid_v, "name": kname_v,
                                          "total_count": 0, "total_sum": 0.0, "cks": {}})
            c = c or 0
            s = float(s or 0)
            it["total_count"] += c
            it["total_sum"] += s
            lvl = (tzv or "-").strip() or "-"
            cell = it["cks"].setdefault(lvl, {"count": 0, "sum": 0.0})
            cell["count"] += c
            cell["sum"] += s
        result = sorted(items.values(), key=lambda x: -x["total_sum"])
        return result


@app.get("/api/raions")
def raions(region_id: int = Query(...), gender_filter: str = Query(None),
           age_group: str = Query(None), pay_group: str = Query(None)):
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.kato_raion,
            Payment.kato_rainame,
            func.count(Payment.id).label("count"),
            func.sum(Payment.nsum).label("total_sum"),
            func.count(distinct(Payment.sicid)).label("recipients"),
        ).filter(
            Payment.kato_region == region_id
        ), gender_filter, age_group, pay_group).group_by(
            Payment.kato_raion, Payment.kato_rainame).all()
        return [
            {
                "id_rai": r.kato_raion,
                "name": r.kato_rainame,
                "count": r.count,
                "total_sum": float(r.total_sum or 0),
                "recipients": r.recipients,
            }
            for r in rows if r.kato_raion is not None
        ]


# ─────────── Раздел «Совпадение ИИ с заключениями врачей-экспертов» ───────────
@app.get("/api/ai/summary")
def ai_summary(region_id: int = Query(None), disease: str = Query(None)):
    return ai_data.summary(region_id, disease)


@app.get("/api/ai/regions")
def ai_regions(disease: str = Query(None)):
    return ai_data.regions(disease)


@app.get("/api/ai/groups")
def ai_groups(region_id: int = Query(None), disease: str = Query(None)):
    return ai_data.groups(region_id, disease)


@app.get("/api/ai/diseases")
def ai_diseases(region_id: int = Query(None)):
    return ai_data.diseases(region_id)


@app.get("/api/ai/disease-list")
def ai_disease_list():
    return ai_data.disease_list()


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")
