"""Business rules of the catalog and the database queries (no SQL built from client text).

All methods are synchronous (SQLAlchemy); the async endpoints call them in the thread pool.
Results are plain dicts in the JSON shape of the API, so they can be cached.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .cache import TtlCache
from .models import Category, Product
from .schemas import ProductInput


def iso_utc(value: datetime) -> str:
    """2026-11-09T08:30:12.457Z (frontend-api.md, dates). SQLite returns naive datetimes: UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def money(value: Decimal) -> str:
    return str(Decimal(value).quantize(Decimal("0.01")))


def summary(product: Product) -> dict:
    return {
        "id": str(product.id),
        "name": product.name,
        "price": money(product.price),
        "currency": product.currency,
        "categoryId": str(product.category_id),
        "imageUrl": product.image_url,
    }


def detail(product: Product) -> dict:
    """ProductDetail without rating and availability (added by the endpoint)."""
    return {
        "id": str(product.id),
        "name": product.name,
        "description": product.description,
        "price": money(product.price),
        "currency": product.currency,
        "category": {"id": str(product.category.id), "name": product.category.name},
        "imageUrl": product.image_url,
        "createdAt": iso_utc(product.created_at),
        "updatedAt": iso_utc(product.updated_at),
    }


class Catalog:
    def __init__(self, session_factory: sessionmaker[Session], cache: TtlCache):
        self.session_factory = session_factory
        self.cache = cache

    # ----- reading -----

    def categories(self) -> list[dict]:
        def load() -> list[dict]:
            with self.session_factory() as session:
                rows = session.scalars(select(Category).order_by(Category.name, Category.id))
                return [{"id": str(c.id), "name": c.name} for c in rows]

        return self.cache.get_or_load(("categories",), load)

    def search(self, q: str | None, category_id: uuid.UUID | None, min_price: Decimal | None,
               max_price: Decimal | None, sort: str, page: int, size: int) -> dict:
        key = ("search", q, category_id, min_price, max_price, sort, page, size)

        def load() -> dict:
            conditions = [Product.deleted_at.is_(None)]
            if q:
                text = q.lower()
                # Case-insensitive, in name and description; % and _ in the text are literal.
                conditions.append(
                    func.lower(Product.name).contains(text, autoescape=True)
                    | func.lower(Product.description).contains(text, autoescape=True)
                )
            if category_id is not None:
                conditions.append(Product.category_id == category_id)
            if min_price is not None:
                conditions.append(Product.price >= min_price)
            if max_price is not None:
                conditions.append(Product.price <= max_price)
            order = {
                "NAME": (Product.name, Product.id),
                "PRICE_ASC": (Product.price, Product.name, Product.id),
                "PRICE_DESC": (Product.price.desc(), Product.name, Product.id),
                "NEWEST": (Product.created_at.desc(), Product.id),
            }[sort]
            with self.session_factory() as session:
                total = session.scalar(select(func.count()).select_from(Product).where(*conditions))
                rows = session.scalars(
                    select(Product).where(*conditions).order_by(*order).offset((page - 1) * size).limit(size)
                )
                items = [summary(p) for p in rows]
            return {"items": items, "page": page, "size": size, "total": total or 0}

        return self.cache.get_or_load(key, load)

    def get(self, product_id: uuid.UUID) -> dict:
        """ProductDetail without rating and availability; 404 also for a withdrawn product (D4)."""

        def load() -> dict | None:
            with self.session_factory() as session:
                product = session.get(Product, product_id)
                if product is None or product.deleted_at is not None:
                    return None
                return detail(product)

        result = self.cache.get_or_load(("product", product_id), load)
        if result is None:
            raise HTTPException(404, "Product not found")
        return result

    # ----- writing (ADMIN); every write clears the cache -----

    def _require_category(self, session: Session, category_id: uuid.UUID) -> Category:
        category = session.get(Category, category_id)
        if category is None:
            raise HTTPException(400, "Unknown categoryId")
        return category

    def create(self, data: ProductInput) -> dict:
        now = datetime.now(UTC)
        with self.session_factory() as session, session.begin():
            category = self._require_category(session, data.category_id)
            product = Product(
                id=uuid.uuid4(),
                name=data.name,
                description=data.description,
                price=Decimal(data.price),
                currency=data.currency,
                category=category,
                image_url=data.image_url,
                created_at=now,
                updated_at=now,
            )
            session.add(product)
            session.flush()
            result = detail(product)
        self.cache.clear()
        return result

    def replace(self, product_id: uuid.UUID, data: ProductInput) -> dict:
        with self.session_factory() as session, session.begin():
            product = session.get(Product, product_id, with_for_update=True)
            if product is None or product.deleted_at is not None:
                raise HTTPException(404, "Product not found")
            category = self._require_category(session, data.category_id)
            product.name = data.name
            product.description = data.description
            product.price = Decimal(data.price)
            product.currency = data.currency
            product.category = category
            product.image_url = data.image_url
            product.updated_at = datetime.now(UTC)
            session.flush()
            result = detail(product)
        self.cache.clear()
        return result

    def withdraw(self, product_id: uuid.UUID) -> None:
        """DELETE: the product disappears from the catalog. Reviews, stock and order lines stay in their
        services (orders keep a copy of name and price), so the row is kept with deleted_at."""
        with self.session_factory() as session, session.begin():
            product = session.get(Product, product_id, with_for_update=True)
            if product is None or product.deleted_at is not None:
                raise HTTPException(404, "Product not found")
            product.deleted_at = datetime.now(UTC)
        self.cache.clear()
