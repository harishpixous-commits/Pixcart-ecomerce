"""Product questions and answers, back-in-stock alerts, product comparison and "Frequently bought together".

Questions: any signed-in shopper asks; the seller, verified buyers and (unless switched off) other shoppers answer.
Posts with phone numbers, emails or links wait for staff; reports hide a post until staff check it. Admin → Questions
moderates; switches live in Admin → Product page."""
from __future__ import annotations

import re
import uuid
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update

from app.core.deps import CurrentUser, OptionalUser, SellerAccount, SessionDep, audit, rate_limit
from app.core.errors import ApiError, NotFound
from app.core.permissions import Perm
from app.db import utcnow
from app.models import (
    AnswerVote,
    Deal,
    Order,
    OrderItem,
    Product,
    ProductAnswer,
    ProductQuestion,
    ProductReport,
    Seller,
    StockAlert,
    SubOrder,
    User,
    Variant,
    WishlistItem,
)
from app.routers.catalog import product_cards
from app.services import engagement as svc
from app.services.catalog import images_for, public_product_filter, variant_label
from app.services.notify import notify, notify_seller
from app.services.platform_settings import get_settings
from app.services.product_info import details_of, info_rows

router = APIRouter(tags=["engagement"])

_CONTACT = re.compile(r"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d))", re.IGNORECASE)
REPORT_HIDE_AT = 3
ROLE_LABEL = {"seller": "Seller", "buyer": "Verified buyer", "customer": "Customer", "staff": "Store team"}


def _first(name: str | None) -> str:
    return (name or "Customer").split(" ")[0]


async def _product(session, slug: str) -> Product:
    p = (await session.execute(select(Product).where(Product.slug == slug, *public_product_filter()))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    return p


async def _is_buyer(session, user_id: uuid.UUID, product_id: uuid.UUID) -> bool:
    return (await session.execute(select(SubOrder.id).join(Order, Order.id == SubOrder.order_id).join(OrderItem, OrderItem.sub_order_id == SubOrder.id)
                                  .where(Order.user_id == user_id, OrderItem.product_id == product_id, SubOrder.status == "delivered").limit(1))).first() is not None


async def _refresh_count(session, question_id: uuid.UUID) -> None:
    n = (await session.execute(select(func.count()).select_from(ProductAnswer).where(ProductAnswer.question_id == question_id, ProductAnswer.status == "published"))).scalar_one()
    await session.execute(update(ProductQuestion).where(ProductQuestion.id == question_id).values(answer_count=n))


# ============================================================================ shoppers


class QuestionIn(BaseModel):
    text: str = Field(min_length=10, max_length=500)


class AnswerIn(BaseModel):
    text: str = Field(min_length=2, max_length=1000)


@router.get("/api/catalog/products/{slug}/questions")
async def questions(slug: str, session: SessionDep, user: OptionalUser, q: str = Query(default="", max_length=80),
                    sort: Literal["helpful", "recent"] = "helpful", page: int = Query(default=1, ge=1, le=200)) -> dict:
    cfg = await get_settings(session)
    p = await _product(session, slug)
    if not cfg["feature_qa"]:
        return {"enabled": False, "items": [], "total": 0, "page": page, "has_more": False}
    conds = [ProductQuestion.product_id == p.id, ProductQuestion.status == "published"]
    if q.strip():
        like = f"%{q.strip()}%"
        conds.append(or_(ProductQuestion.text.ilike(like), ProductQuestion.id.in_(
            select(ProductAnswer.question_id).where(ProductAnswer.status == "published", ProductAnswer.text.ilike(like)))))
    order = [ProductQuestion.answer_count.desc(), ProductQuestion.created_at.desc()] if sort == "helpful" else [ProductQuestion.created_at.desc()]
    total = (await session.execute(select(func.count()).select_from(ProductQuestion).where(*conds))).scalar_one()
    rows = (await session.execute(select(ProductQuestion, User.name).outerjoin(User, User.id == ProductQuestion.user_id).where(*conds)
                                  .order_by(*order, ProductQuestion.id).offset((page - 1) * 10).limit(10))).all()
    qids = [r[0].id for r in rows]
    answers: dict = {}
    voted: set = set()
    if qids:
        for a, name in (await session.execute(select(ProductAnswer, User.name).outerjoin(User, User.id == ProductAnswer.user_id)
                                              .where(ProductAnswer.question_id.in_(qids), ProductAnswer.status == "published")
                                              .order_by(ProductAnswer.role == "seller", ProductAnswer.helpful_count.desc(), ProductAnswer.created_at))).all():
            answers.setdefault(a.question_id, []).append((a, name))
        if user:
            ids = [a.id for lst in answers.values() for a, _ in lst]
            voted = set((await session.execute(select(AnswerVote.answer_id).where(AnswerVote.user_id == user.id, AnswerVote.answer_id.in_(ids))))
                        .scalars()) if ids else set()
    seller = await session.get(Seller, p.seller_id)
    items = []
    for qn, name in rows:
        lst = sorted(answers.get(qn.id, []), key=lambda x: (x[0].role != "seller", -x[0].helpful_count, x[0].created_at))
        items.append({
            "id": str(qn.id), "text": qn.text, "author": _first(name), "created_at": qn.created_at.isoformat(), "answer_count": qn.answer_count,
            "answers": [{"id": str(a.id), "text": a.text, "author": seller.display_name if a.role == "seller" else _first(n), "role": a.role,
                         "role_label": ROLE_LABEL[a.role], "helpful_count": a.helpful_count, "voted": a.id in voted, "created_at": a.created_at.isoformat()}
                        for a, n in lst],
        })
    return {"enabled": True, "items": items, "total": total, "page": page, "has_more": page * 10 < total,
            "can_ask": user is not None, "buyers_answer_only": cfg["qa_buyers_answer_only"]}


@router.post("/api/catalog/products/{slug}/questions", status_code=201)
async def ask(slug: str, body: QuestionIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_qa"]:
        raise ApiError("Questions are switched off", "qa_off")
    p = await _product(session, slug)
    await rate_limit(session, f"qa-ask:{user.id}", limit=10, window_seconds=86400)
    text = " ".join(body.text.split())
    held = cfg["qa_need_approval"] or bool(_CONTACT.search(text))
    qn = ProductQuestion(product_id=p.id, user_id=user.id, text=text, status="pending" if held else "published", answer_count=0, report_count=0, created_at=utcnow())
    session.add(qn)
    await session.flush()
    if not held:
        await notify_seller(session, p.seller_id, "seller_new_question", {"item": p.title, "question": text[:200]}, link="/seller/questions")
    await session.commit()
    return {"ok": True, "id": str(qn.id), "status": qn.status}


@router.post("/api/questions/{question_id}/answers", status_code=201)
async def answer(question_id: uuid.UUID, body: AnswerIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_qa"]:
        raise ApiError("Questions are switched off", "qa_off")
    qn = await session.get(ProductQuestion, question_id)
    if qn is None or qn.status != "published":
        raise NotFound("Question")
    p = await session.get(Product, qn.product_id)
    seller = await session.get(Seller, p.seller_id)
    role = "seller" if seller and seller.user_id == user.id else "buyer" if await _is_buyer(session, user.id, p.id) else "customer"
    if role == "customer" and cfg["qa_buyers_answer_only"]:
        raise ApiError("Only the seller and customers who bought this product can answer", "buyers_only")
    if qn.user_id == user.id and role != "seller":
        raise ApiError("You asked this question; wait for an answer from the seller or a buyer", "own_question")
    await rate_limit(session, f"qa-answer:{user.id}", limit=30, window_seconds=86400)
    text = body.text.strip()
    held = cfg["qa_need_approval"] or bool(_CONTACT.search(text))
    a = ProductAnswer(question_id=qn.id, user_id=user.id, role=role, text=text, status="pending" if held else "published", helpful_count=0, report_count=0, created_at=utcnow())
    session.add(a)
    await session.flush()
    if not held:
        await _refresh_count(session, qn.id)
        asker = await session.get(User, qn.user_id) if qn.user_id else None
        if asker and asker.id != user.id:
            await notify(session, "question_answered", asker, {"item": p.title, "question": qn.text[:200], "answer": text[:300],
                                                                "answerer": ROLE_LABEL[role] if role != "seller" else seller.display_name}, link=f"/p/{p.slug}#questions")
    await session.commit()
    return {"ok": True, "id": str(a.id), "status": a.status, "role": role}


@router.post("/api/answers/{answer_id}/helpful")
async def answer_helpful(answer_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    a = await session.get(ProductAnswer, answer_id)
    if a is None or a.status != "published":
        raise NotFound("Answer")
    if a.user_id == user.id:
        raise ApiError("You cannot vote on your own answer", "own_answer")
    v = await session.get(AnswerVote, (answer_id, user.id))
    if v:
        await session.delete(v)
        delta = -1
    else:
        session.add(AnswerVote(answer_id=answer_id, user_id=user.id, created_at=utcnow()))
        delta = 1
    await session.execute(update(ProductAnswer).where(ProductAnswer.id == answer_id).values(helpful_count=func.greatest(ProductAnswer.helpful_count + delta, 0)))
    await session.commit()
    await session.refresh(a)
    return {"voted": delta == 1, "helpful_count": a.helpful_count}


class QaReportIn(BaseModel):
    kind: Literal["question", "answer"]
    id: uuid.UUID


@router.post("/api/qa/report")
async def qa_report(body: QaReportIn, user: CurrentUser, session: SessionDep) -> dict:
    """Flags a question or answer; after a few reports it waits for staff."""
    await rate_limit(session, f"qa-report:{user.id}", limit=30, window_seconds=86400)
    obj = await session.get(ProductQuestion if body.kind == "question" else ProductAnswer, body.id)
    if obj is None or obj.status != "published":
        raise NotFound("Post")
    obj.report_count += 1
    if obj.report_count >= REPORT_HIDE_AT:
        obj.status = "pending"
        if body.kind == "answer":
            await session.flush()
            await _refresh_count(session, obj.question_id)
    await session.commit()
    return {"ok": True}


# ============================================================================ alerts


class AlertIn(BaseModel):
    variant_id: uuid.UUID


@router.post("/api/alerts/stock", status_code=201)
async def stock_alert(body: AlertIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_stock_alerts"]:
        raise ApiError("Stock alerts are switched off", "alerts_off")
    v = await session.get(Variant, body.variant_id)
    if v is None or not v.is_active:
        raise NotFound("Product")
    a = await session.get(StockAlert, (user.id, v.id))
    if a is None:
        count = (await session.execute(select(func.count()).select_from(StockAlert).where(StockAlert.user_id == user.id, StockAlert.active.is_(True)))).scalar_one()
        if count >= 100:
            raise ApiError("You can follow up to 100 items", "too_many_alerts")
        session.add(StockAlert(user_id=user.id, variant_id=v.id, created_at=utcnow(), notified_at=None, active=True))
    else:
        a.active, a.notified_at = True, None
    await session.commit()
    return {"ok": True, "subscribed": True}


@router.delete("/api/alerts/stock/{variant_id}")
async def stock_alert_off(variant_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    a = await session.get(StockAlert, (user.id, variant_id))
    if a:
        await session.delete(a)
        await session.commit()
    return {"ok": True, "subscribed": False}


@router.get("/api/alerts")
async def my_alerts(user: CurrentUser, session: SessionDep, variant_id: uuid.UUID | None = None) -> dict:
    stmt = (select(StockAlert, Variant, Product).join(Variant, Variant.id == StockAlert.variant_id).join(Product, Product.id == Variant.product_id)
            .where(StockAlert.user_id == user.id, StockAlert.active.is_(True)))
    if variant_id:
        stmt = stmt.where(StockAlert.variant_id == variant_id)
    rows = (await session.execute(stmt.order_by(StockAlert.created_at.desc()))).all()
    imgs = await images_for(session, list({p.id for _, _, p in rows}))
    return {"stock": [{"variant_id": str(v.id), "product": p.title, "slug": p.slug, "variant": variant_label(v.options), "image": (imgs.get(p.id) or [""])[0],
                       "in_stock": v.stock > 0, "created_at": a.created_at.isoformat()} for a, v, p in rows]}


# ============================================================================ compare and bought together


@router.get("/api/catalog/compare")
async def compare(session: SessionDep, ids: str = Query(max_length=200)) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_compare"]:
        raise ApiError("Compare is switched off", "compare_off")
    want = []
    for x in ids.split(",")[:4]:
        try:
            want.append(uuid.UUID(x.strip()))
        except ValueError:
            continue
    products = await svc.compare_rows(session, want)
    cards = await product_cards(session, products)
    spec_count: dict[str, int] = {}
    for p in products:
        for k in p.specs:
            spec_count[k] = spec_count.get(k, 0) + 1
    keys = sorted(spec_count, key=lambda k: (-spec_count[k], k))
    items = []
    for card, p in zip(cards, products, strict=True):
        info = {r["label"]: r["value"] for r in info_rows(details_of(p.details), brand=p.brand, country_of_origin=p.country_of_origin)}
        items.append(card | {"specs": p.specs, "info": info, "return_window_days": p.return_window_days, "highlights": p.highlights[:5]})
    info_keys = []
    for it in items:
        for k in it["info"]:
            if k not in info_keys:
                info_keys.append(k)
    return {"items": items, "spec_keys": keys, "info_keys": info_keys}


@router.get("/api/catalog/products/{slug}/bought-together")
async def bought_together(slug: str, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_bought_together"]:
        return {"items": []}
    p = await _product(session, slug)
    others = await svc.bought_together(session, p)
    if not others:
        return {"items": []}
    return {"items": await product_cards(session, [p, *others])}  # the product itself first


# ============================================================================ seller


@router.get("/api/seller/questions")
async def seller_questions(seller: SellerAccount, session: SessionDep, unanswered: bool = False, page: int = Query(default=1, ge=1)) -> dict:
    stmt = (select(ProductQuestion, Product.title, Product.slug).join(Product, Product.id == ProductQuestion.product_id)
            .where(Product.seller_id == seller.id, ProductQuestion.status == "published"))
    if unanswered:
        stmt = stmt.where(~ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.role == "seller")))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(ProductQuestion.created_at.desc()).offset((page - 1) * 20).limit(20))).all()
    qids = [r[0].id for r in rows]
    answers: dict = {}
    if qids:
        for a in (await session.execute(select(ProductAnswer).where(ProductAnswer.question_id.in_(qids), ProductAnswer.status != "hidden")
                                        .order_by(ProductAnswer.created_at))).scalars():
            answers.setdefault(a.question_id, []).append({"id": str(a.id), "text": a.text, "role": a.role, "role_label": ROLE_LABEL[a.role],
                                                          "status": a.status, "created_at": a.created_at.isoformat()})
    waiting = (await session.execute(select(func.count()).select_from(ProductQuestion).join(Product, Product.id == ProductQuestion.product_id).where(
        Product.seller_id == seller.id, ProductQuestion.status == "published",
        ~ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.role == "seller"))))).scalar_one()
    return {"items": [{"id": str(q.id), "text": q.text, "product": t, "slug": s, "created_at": q.created_at.isoformat(), "answers": answers.get(q.id, []),
                       "answered_by_you": any(a["role"] == "seller" for a in answers.get(q.id, []))} for q, t, s in rows],
            "total": total, "page": page, "unanswered": waiting}


@router.get("/api/seller/badges")
async def seller_badges(seller: SellerAccount, session: SessionDep) -> dict:
    """Small counts for the seller hub menu: orders to confirm, questions waiting for an answer, open customer reports."""
    orders = (await session.execute(select(func.count()).select_from(SubOrder).where(SubOrder.seller_id == seller.id, SubOrder.status == "placed"))).scalar_one()
    questions = (await session.execute(select(func.count()).select_from(ProductQuestion).join(Product, Product.id == ProductQuestion.product_id).where(
        Product.seller_id == seller.id, ProductQuestion.status == "published",
        ~ProductQuestion.id.in_(select(ProductAnswer.question_id).where(ProductAnswer.role == "seller"))))).scalar_one()
    reports = (await session.execute(select(func.count()).select_from(ProductReport).join(Product, Product.id == ProductReport.product_id).where(
        Product.seller_id == seller.id, ProductReport.status == "open"))).scalar_one()
    deals = (await session.execute(select(func.count()).select_from(Deal).where(Deal.seller_id == seller.id, Deal.status == "active"))).scalar_one()
    return {"orders": orders, "questions": questions, "reports": reports, "deals_running": deals}


@router.post("/api/seller/questions/{question_id}/answer", status_code=201)
async def seller_answer(question_id: uuid.UUID, body: AnswerIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    qn = await session.get(ProductQuestion, question_id)
    p = await session.get(Product, qn.product_id) if qn else None
    if qn is None or p.seller_id != seller.id:
        raise NotFound("Question")
    return await answer(question_id, body, user, session)


# ============================================================================ admin


@router.get("/api/admin/questions")
async def admin_questions(admin: Perm("catalog"), session: SessionDep, status: Literal["pending", "published", "hidden"] = "pending",
                          q: str = Query(default="", max_length=80), page: int = Query(default=1, ge=1)) -> dict:
    """Questions and answers in one queue: each row is a post (question or answer) with its context."""
    like = f"%{q.strip()}%" if q.strip() else None
    qs = select(ProductQuestion, Product.title, Product.slug, User.name).join(Product, Product.id == ProductQuestion.product_id).outerjoin(
        User, User.id == ProductQuestion.user_id).where(ProductQuestion.status == status)
    ans = (select(ProductAnswer, ProductQuestion.text, Product.title, Product.slug, User.name).join(ProductQuestion, ProductQuestion.id == ProductAnswer.question_id)
           .join(Product, Product.id == ProductQuestion.product_id).outerjoin(User, User.id == ProductAnswer.user_id).where(ProductAnswer.status == status))
    if like:
        qs = qs.where(or_(ProductQuestion.text.ilike(like), Product.title.ilike(like)))
        ans = ans.where(or_(ProductAnswer.text.ilike(like), Product.title.ilike(like)))
    rows = [{"kind": "question", "id": str(x.id), "text": x.text, "product": t, "slug": s, "author": name or "Deleted account", "role": "customer",
             "report_count": x.report_count, "created_at": x.created_at.isoformat(), "question": ""} for x, t, s, name in (await session.execute(qs.limit(200))).all()]
    rows += [{"kind": "answer", "id": str(a.id), "text": a.text, "product": t, "slug": s, "author": name or "Deleted account", "role": a.role,
              "report_count": a.report_count, "created_at": a.created_at.isoformat(), "question": qt} for a, qt, t, s, name in (await session.execute(ans.limit(200))).all()]
    rows.sort(key=lambda r: (r["report_count"], r["created_at"]), reverse=True)  # most reported first, then newest
    counts = {
        st: (await session.execute(select(func.count()).select_from(ProductQuestion).where(ProductQuestion.status == st))).scalar_one()
        + (await session.execute(select(func.count()).select_from(ProductAnswer).where(ProductAnswer.status == st))).scalar_one()
        for st in ("pending", "published", "hidden")
    }
    start = (page - 1) * 30
    return {"items": rows[start:start + 30], "total": len(rows), "page": page, "page_size": 30, "counts": counts}


@router.post("/api/admin/questions/{kind}/{post_id}/{action}")
async def admin_question_action(kind: Literal["question", "answer"], post_id: uuid.UUID, action: Literal["publish", "hide"], admin: Perm("catalog"),
                                session: SessionDep) -> dict:
    obj = await session.get(ProductQuestion if kind == "question" else ProductAnswer, post_id)
    if obj is None:
        raise NotFound("Post")
    obj.status = "published" if action == "publish" else "hidden"
    obj.report_count = 0
    await session.flush()
    if kind == "answer":
        await _refresh_count(session, obj.question_id)
    audit(session, admin, f"qa.{kind}.{action}", kind, obj.id)
    await session.commit()
    return {"ok": True, "status": obj.status}


async def wishlist_price_on_add(session, user_id: uuid.UUID, product_id: uuid.UUID) -> None:
    """Remembers the price when a product is saved, for price-drop alerts."""
    w = await session.get(WishlistItem, (user_id, product_id))
    p = await session.get(Product, product_id)
    if w is not None and p is not None and w.price_at_add is None:
        w.price_at_add = p.price_from
