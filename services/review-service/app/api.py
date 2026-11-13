import logging
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, Path, Query, Request, Response
from pymongo.collection import Collection
from pymongo.errors import DuplicateKeyError

from app import db as database
from app.db import get_reviews
from app.errors import ApiError
from app.order_client import OrderClient, OrderServiceUnavailable, get_order_client
from app.schemas import ReviewCreate, ReviewOut, ReviewPage, ReviewSummary
from app.security import Principal, get_principal

logger = logging.getLogger(__name__)

router = APIRouter()
health = APIRouter(tags=["health"])


def require_user(principal: Principal | None = Depends(get_principal)) -> Principal:
    if principal is None or not principal.user_id:
        raise ApiError(401, "UNAUTHORIZED", "Wymagane uwierzytelnienie")
    return principal


def _to_out(doc: dict) -> ReviewOut:
    created = doc["createdAt"]
    if created.tzinfo is None:  # Mongo zwraca daty w UTC bez strefy
        created = created.replace(tzinfo=timezone.utc)
    return ReviewOut(
        id=str(doc["_id"]),
        product_id=doc["productId"],
        user_id=doc["userId"],
        rating=doc["rating"],
        comment=doc.get("comment"),
        created_at=created,
    )


@health.get("/health/live")
def live():
    return {"status": "UP"}


@health.get("/health/ready")
def ready():
    try:
        database.ping()
    except Exception:
        logger.warning("MongoDB niedostępny", exc_info=True)
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Baza danych niedostępna")
    return {"status": "UP"}


@router.get("/reviews", response_model=ReviewPage, tags=["reviews"])
def list_reviews(
    product_id: int = Query(alias="productId", gt=0),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    reviews: Collection = Depends(get_reviews),
):
    """Opinie o produkcie, od najnowszych."""
    query = {"productId": product_id}
    cursor = reviews.find(query).sort([("createdAt", -1), ("_id", -1)]).skip((page - 1) * size).limit(size)
    return ReviewPage(
        items=[_to_out(d) for d in cursor],
        page=page,
        size=size,
        total=reviews.count_documents(query),
    )


@router.get("/reviews/summary/{product_id}", response_model=ReviewSummary, tags=["reviews"])
def summary(product_id: int = Path(gt=0), reviews: Collection = Depends(get_reviews)):
    """Średnia ocena i liczba opinii (wołane przez Product Service). Brak opinii: averageRating = null."""
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
    principal: Principal = Depends(require_user),
    reviews: Collection = Depends(get_reviews),
    orders: OrderClient = Depends(get_order_client),
):
    """Dodaje opinię. Tylko użytkownik, który kupił produkt (sprawdzane w Order Service), jedna opinia na produkt."""
    if reviews.find_one({"productId": body.product_id, "userId": principal.user_id}, {"_id": 1}):
        raise ApiError(409, "CONFLICT", "Opinia o tym produkcie została już dodana")

    forward = {"X-Request-Id": request.state.request_id}
    if request.headers.get("authorization"):
        forward["Authorization"] = request.headers["authorization"]
    try:
        purchased = orders.has_purchased(principal.user_id, body.product_id, forward)
    except OrderServiceUnavailable as exc:
        logger.warning("Nie można zweryfikować zakupu: %s", exc)
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Nie można zweryfikować zakupu, spróbuj ponownie później")
    if not purchased:
        raise ApiError(403, "FORBIDDEN", "Opinię może dodać tylko osoba, która kupiła ten produkt")

    doc = {
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
    review_id: str = Path(min_length=1, max_length=64),
    principal: Principal = Depends(require_user),
    reviews: Collection = Depends(get_reviews),
):
    """Usuwa opinię. Może to zrobić jej autor albo ADMIN."""
    doc = reviews.find_one({"_id": ObjectId(review_id)}) if ObjectId.is_valid(review_id) else None
    if doc is None:
        raise ApiError(404, "NOT_FOUND", "Opinia nie istnieje")
    if doc["userId"] != principal.user_id and "ADMIN" not in principal.roles:
        raise ApiError(403, "FORBIDDEN", "Możesz usunąć tylko własną opinię")
    reviews.delete_one({"_id": doc["_id"]})
    return Response(status_code=204)
