"""MongoDB notification_db: the log of sent e-mails, which is also the list of processed eventIds.

One document per sent e-mail; a unique index on eventId stops a second e-mail for the same event
(docs/events.md, "Idempotencja w Notification"). _id is a UUID as text, not an ObjectId (D1).
pymongo is synchronous, so every call runs in a thread (asyncio.to_thread) and never blocks the loop.
"""

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Protocol

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError

from .config import Settings

COLLECTION = "notifications"


class Store(Protocol):
    async def ensure_indexes(self) -> None: ...
    async def ping(self) -> bool: ...
    async def is_processed(self, event_id: str) -> bool: ...
    async def record(self, entry: dict) -> bool: ...
    async def list_for_user(self, user_id: str, page: int, size: int) -> tuple[list[dict], int]: ...
    def close(self) -> None: ...


def new_entry(event: dict, user_id: str | None, subject: str) -> dict:
    """What is kept about a sent e-mail: identifiers, type and subject. Not the address or the body."""
    return {
        "_id": str(uuid.uuid4()),
        "eventId": event["eventId"],
        "type": event["type"],
        "requestId": event["requestId"],
        "userId": user_id,
        "subject": subject,
        "sentAt": datetime.now(UTC),
    }


class MongoStore:
    def __init__(self, settings: Settings):
        # Separate parameters instead of a mongodb:// address: the password is never part of a URL
        # that could end up in a log (D6, D16).
        self.client = MongoClient(
            host=settings.db_host,
            port=settings.db_port,
            username=settings.db_user or None,
            password=settings.db_password or None,
            authSource=settings.db_name,
            serverSelectionTimeoutMS=2000,
            connectTimeoutMS=2000,
            socketTimeoutMS=5000,
            uuidRepresentation="standard",
            tz_aware=True,
        )
        self.collection = self.client[settings.db_name][COLLECTION]

    async def ensure_indexes(self) -> None:
        def create() -> None:
            self.collection.create_index([("eventId", ASCENDING)], unique=True, name="eventId_unique")
            self.collection.create_index([("userId", ASCENDING), ("sentAt", DESCENDING)], name="userId_sentAt")

        await asyncio.to_thread(create)

    async def ping(self) -> bool:
        def command() -> bool:
            self.client.admin.command("ping")
            return True

        try:
            return await asyncio.wait_for(asyncio.to_thread(command), 3)
        except (PyMongoError, TimeoutError):
            return False

    async def is_processed(self, event_id: str) -> bool:
        found = await asyncio.to_thread(self.collection.find_one, {"eventId": event_id}, {"_id": 1})
        return found is not None

    async def record(self, entry: dict) -> bool:
        """False when the eventId is already there (another instance sent the e-mail at the same time)."""
        try:
            await asyncio.to_thread(self.collection.insert_one, entry)
            return True
        except DuplicateKeyError:
            return False

    async def list_for_user(self, user_id: str, page: int, size: int) -> tuple[list[dict], int]:
        def query() -> tuple[list[dict], int]:
            condition = {"userId": user_id}
            total = self.collection.count_documents(condition)
            cursor = (
                self.collection.find(condition, {"type": 1, "subject": 1, "sentAt": 1})
                .sort([("sentAt", DESCENDING), ("_id", ASCENDING)])
                .skip((page - 1) * size)
                .limit(size)
            )
            return list(cursor), total

        return await asyncio.to_thread(query)

    def close(self) -> None:
        self.client.close()
