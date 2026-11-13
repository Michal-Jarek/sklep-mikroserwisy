"""Endpoints of Product (docs/frontend-api.md, section Product). Paths without /api/v1 (D12).

Database work runs in the thread pool (run_in_threadpool), so the event loop stays free for the
calls to Review and Inventory.
"""

import uuid
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from .catalog import Catalog
from .clients import Enrichment
from .schemas import PRICE_FILTER_PATTERN, CategoryView, ProductDetail, ProductInput, ProductPage, SortOrder
from .web import Identity, admin_only, identity

router = APIRouter()
Caller = Annotated[Identity, Depends(identity)]
Admin = Annotated[Identity, Depends(admin_only)]


def catalog(request: Request) -> Catalog:
    return request.app.state.catalog


def enrichment(request: Request) -> Enrichment:
    return request.app.state.enrichment


CatalogDep = Annotated[Catalog, Depends(catalog)]
EnrichmentDep = Annotated[Enrichment, Depends(enrichment)]


# FastAPI does not answer HEAD on a GET route (405), so every GET route gets HEAD as well (D12).
@router.head("/products", include_in_schema=False)
@router.get("/products", response_model=ProductPage, tags=["products"])
async def list_products(
    cat: CatalogDep,
    who: Caller,
    q: Annotated[str | None, Query(max_length=200)] = None,
    category_id: Annotated[uuid.UUID | None, Query(alias="categoryId")] = None,
    min_price: Annotated[str | None, Query(alias="minPrice", pattern=PRICE_FILTER_PATTERN)] = None,
    max_price: Annotated[str | None, Query(alias="maxPrice", pattern=PRICE_FILTER_PATTERN)] = None,
    sort: SortOrder = "NAME",
    page: Annotated[int, Query(ge=1)] = 1,
    size: Annotated[int, Query(ge=1, le=100)] = 20,
):
    low = Decimal(min_price) if min_price is not None else None
    high = Decimal(max_price) if max_price is not None else None
    if low is not None and high is not None and low > high:
        raise HTTPException(400, "minPrice must not be greater than maxPrice")
    text = q.strip() if q else None
    return await run_in_threadpool(cat.search, text or None, category_id, low, high, sort, page, size)


@router.head("/products/{product_id}", include_in_schema=False)
@router.get("/products/{product_id}", response_model=ProductDetail, tags=["products"])
async def get_product(product_id: uuid.UUID, cat: CatalogDep, extra: EnrichmentDep, who: Caller):
    product = dict(await run_in_threadpool(cat.get, product_id))
    if "SERVICE" in who.roles:
        # Light read for Cart, Order and Review: no calls to Review or Inventory (D4).
        product["rating"], product["availability"] = None, None
    else:
        product["rating"], product["availability"] = await extra.for_product(product_id, who)
    return product


@router.head("/categories", include_in_schema=False)
@router.get("/categories", response_model=list[CategoryView], tags=["categories"])
async def list_categories(cat: CatalogDep, who: Caller):
    return await run_in_threadpool(cat.categories)


@router.post("/products", response_model=ProductDetail, status_code=201, tags=["products"])
async def create_product(data: ProductInput, cat: CatalogDep, who: Admin):
    product = await run_in_threadpool(cat.create, data)
    # A new product has no reviews and no stock yet (stock is set in Inventory).
    return {**product, "rating": {"average": None, "count": 0}, "availability": None}


@router.put("/products/{product_id}", response_model=ProductDetail, tags=["products"])
async def replace_product(product_id: uuid.UUID, data: ProductInput, cat: CatalogDep, extra: EnrichmentDep, who: Admin):
    product = await run_in_threadpool(cat.replace, product_id, data)
    product["rating"], product["availability"] = await extra.for_product(product_id, who)
    return product


@router.delete("/products/{product_id}", status_code=204, tags=["products"])
async def delete_product(product_id: uuid.UUID, cat: CatalogDep, who: Admin):
    await run_in_threadpool(cat.withdraw, product_id)
    return Response(status_code=204)
