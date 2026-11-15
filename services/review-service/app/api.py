import asyncio
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, Request, Response
from pymongo.collection import Collection
from pymongo.errors import DuplicateKeyError

from app import db as database
from app.db import get_reviews
from app.errors import ApiError
from app.ids import uuid_or_400
from app.order_client import OrderClient, OrderServiceUnavailable, get_order_client
from app.schemas import ReviewCreate, ReviewOut, ReviewPage, ReviewSummary
from app.security import Principal, logged_in

logger = logging.getLogger(__name__)

router = APIRouter()
health = APIRouter(tags=["health"])

READY_DB_TIMEOUT = 1.5  # krócej niż timeout sprawdzenia w Consulu (2 s) i w Kubernetesie


def _to_out(doc: dict) -> ReviewOut:
    created = doc["createdAt"]
    if created.tzinfo is None:  # Mongo zwraca daty w UTC bez strefy
        created = created.replace(tzinfo=timezone.utc)
    return ReviewOut(
        id=doc["_id"],
        product_id=doc["productId"],
        user_id=doc["userId"],
        rating=doc["rating"],
        comment=doc.get("comment"),
        created_at=created,
    )


@health.get("/health/live")
async def live():
    """Proces żyje: bez bazy i bez wątków, więc odpowiada także przy niedostępnej bazie."""
    return {"status": "UP"}


@health.get("/health/ready")
async def ready():
    try:
        await asyncio.wait_for(asyncio.to_thread(database.ping), READY_DB_TIMEOUT)
    except Exception as exc:  # także TimeoutError: baza nie odpowiada
        logger.warning("MongoDB niedostępny", extra={"fields": {"reason": type(exc).__name__}})
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Baza danych niedostępna")
    return {"status": "UP"}


@router.get("/reviews", response_model=ReviewPage, tags=["reviews"])
def list_reviews(
    product_id: str = Query(alias="productId"),
    page: int = Query(1, ge=1, le=1_000_000),  # wyżej (page - 1) * size przekracza liczbę BSON → 500 (CR-15)
    size: int = Query(20, ge=1, le=100),
    reviews: Collection = Depends(get_reviews),
):
    """Opinie o produkcie, od najnowszych."""
    query = {"productId": uuid_or_400(product_id, "productId")}
    cursor = reviews.find(query).sort([("createdAt", -1), ("_id", -1)]).skip((page - 1) * size).limit(size)
    return ReviewPage(
        items=[_to_out(d) for d in cursor],
        page=page,
        size=size,
        total=reviews.count_documents(query),
    )


@router.get("/reviews/summary/{product_id}", response_model=ReviewSummary, tags=["reviews"])
def summary(product_id: str, reviews: Collection = Depends(get_reviews)):
    """Średnia ocena i liczba opinii (wołane przez Product Service). Brak opinii: averageRating = null."""
    product_id = uuid_or_400(product_id, "productId")
    pipeline = [
        {"$match": {"productId": product_id}},
        {"$group": {"_id": "$productId", "avg": {"$avg": "$rating"}, "count": {"$sum": 1}}},
    ]
    result = next(iter(reviews.aggregate(pipeline)), None)
    if result is None:
        return ReviewSummary(product_id=product_id, average_rating=None, review_count=0)
    return ReviewSummary(product_id=product_id, average_rating=round(result["avg"], 2), review_count=result["count"])


@router.post("/reviews", response_model=ReviewOut, status_code=201, tags=["reviews"])
def create_review(
    body: ReviewCreate,
    request: Request,
    principal: Principal = Depends(logged_in),
    reviews: Collection = Depends(get_reviews),
    orders: OrderClient = Depends(get_order_client),
):
    """Dodaje opinię. Tylko użytkownik, który kupił produkt (sprawdzane w Order Service), jedna opinia na produkt."""
    if reviews.find_one({"productId": body.product_id, "userId": principal.user_id}, {"_id": 1}):
        raise ApiError(409, "CONFLICT", "Opinia o tym produkcie została już dodana")

    # wywołanie w imieniu klienta (D11): jego X-User-Id, jego role + SERVICE, bieżący X-Request-Id
    forward = {
        "X-Request-Id": request.state.request_id,
        "X-User-Id": principal.user_id,
        "X-User-Roles": ",".join(sorted(principal.roles | {"SERVICE"})),
    }
    try:
        purchased = orders.has_purchased(principal.user_id, body.product_id, forward)
    except OrderServiceUnavailable:
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Nie można zweryfikować zakupu, spróbuj ponownie później")
    if not purchased:
        raise ApiError(403, "FORBIDDEN", "Opinię może dodać tylko osoba, która kupiła ten produkt")

    doc = {
        "_id": str(uuid.uuid4()),
        "productId": body.product_id,
        "userId": principal.user_id,
        "rating": body.rating,
        "comment": body.comment,
        "createdAt": datetime.now(timezone.utc),
    }
    try:
        reviews.insert_one(doc)
    except DuplicateKeyError:
        raise ApiError(409, "CONFLICT", "Opinia o tym produkcie została już dodana")
    return _to_out(doc)


@router.delete("/reviews/{review_id}", status_code=204, tags=["reviews"])
def delete_review(
    review_id: str,
    principal: Principal = Depends(logged_in),
    reviews: Collection = Depends(get_reviews),
):
    """Usuwa opinię. Może to zrobić jej autor albo ADMIN."""
    doc = reviews.find_one({"_id": uuid_or_400(review_id, "reviewId")})
    if doc is None:
        raise ApiError(404, "NOT_FOUND", "Opinia nie istnieje")
    if doc["userId"] != principal.user_id and "ADMIN" not in principal.roles:
        raise ApiError(403, "FORBIDDEN", "Możesz usunąć tylko własną opinię")
    reviews.delete_one({"_id": doc["_id"]})
    return Response(status_code=204)
