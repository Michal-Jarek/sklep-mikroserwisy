"""Warstwa HTTP deleguje pracę do serwisu i sprawdza uprawnienia."""
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session
from .database import session_dependency
from .schemas import AddressInput, AddressView, CreateUser, UpdateUser, UserView
from .security import Caller, current_user, profile_reader, service_caller
from .service import ProfileService

router = APIRouter(prefix="/users", tags=["users"])
DB = Annotated[Session, Depends(session_dependency)]
Me = Annotated[Caller, Depends(current_user)]
Internal = Annotated[Caller, Depends(service_caller)]
Reader = Annotated[Caller, Depends(profile_reader)]

@router.post("", response_model=UserView, status_code=201)
def create(data: CreateUser, db: DB, caller: Internal):
    return ProfileService(db).create(data)

@router.get("/me", response_model=UserView)
def me(db: DB, caller: Me):
    return ProfileService(db).get(caller.user_id)

@router.put("/me", response_model=UserView)
def update(data: UpdateUser, db: DB, caller: Me):
    return ProfileService(db).update(caller.user_id, data)

@router.get("/me/addresses", response_model=list[AddressView])
def addresses(db: DB, caller: Me):
    return ProfileService(db).addresses(caller.user_id)

@router.post("/me/addresses", response_model=AddressView, status_code=201)
def add_address(data: AddressInput, db: DB, caller: Me):
    return ProfileService(db).add_address(caller.user_id, data)

@router.delete("/me/addresses/{address_id}", status_code=204)
def delete_address(address_id: UUID, db: DB, caller: Me):
    ProfileService(db).delete_address(caller.user_id, address_id)
    return Response(status_code=204)

@router.get("/{user_id}", response_model=UserView)
def get_user(user_id: UUID, db: DB, caller: Reader):
    return ProfileService(db).get(user_id)
