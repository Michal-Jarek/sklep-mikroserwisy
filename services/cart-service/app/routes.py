"""Endpointy koszyka. ID klienta jest z nagłówka, a nie z JSON."""
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, Request, Response
from .schemas import AddItem, CartMutation, CartView, ChangeQuantity
from .security import Caller, current_user, service_caller
from .service import CartService

router = APIRouter(prefix="/cart", tags=["cart"])

def cart_service(request: Request) -> CartService:
    return request.app.state.cart_service

Service = Annotated[CartService, Depends(cart_service)]
Me = Annotated[Caller, Depends(current_user)]
Internal = Annotated[Caller, Depends(service_caller)]

@router.get("", response_model=CartView)
async def get_cart(service: Service, caller: Me):
    return await service.get(caller.user_id)

@router.post("/items", response_model=CartMutation)
async def add_item(data: AddItem, service: Service, caller: Me):
    return await service.change(caller, data.product_id, data.quantity, add=True)

@router.patch("/items/{product_id}", response_model=CartMutation)
async def change_item(product_id: UUID, data: ChangeQuantity, service: Service, caller: Me):
    return await service.change(caller, product_id, data.quantity, add=False)

@router.delete("/items/{product_id}", status_code=204)
async def remove_item(product_id: UUID, service: Service, caller: Me):
    await service.remove(caller.user_id, product_id)
    return Response(status_code=204)

@router.delete("/{user_id}", status_code=204)
async def clear_cart(user_id: UUID, service: Service, caller: Internal):
    await service.clear(user_id)
    return Response(status_code=204)
