import logging

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection

logger = logging.getLogger(__name__)

COLLECTION = "reviews"


class _State:
    client: MongoClient | None = None
    database = None


def init_client(url: str, database: str) -> None:
    if not url:
        raise RuntimeError("Brak MONGODB_URL")
    _State.client = MongoClient(url, serverSelectionTimeoutMS=3000)
    _State.database = _State.client[database]


def get_reviews() -> Collection:
    return _State.database[COLLECTION]


def ensure_indexes(reviews: Collection) -> None:
    # jedna opinia użytkownika o produkcie (ochrona także przed wyścigiem równoległych żądań)
    reviews.create_index([("productId", ASCENDING), ("userId", ASCENDING)], unique=True, name="uq_product_user")
    reviews.create_index([("productId", ASCENDING), ("createdAt", DESCENDING)], name="ix_product_created")


def ping() -> None:
    _State.client.admin.command("ping")


def close() -> None:
    if _State.client is not None:
        _State.client.close()
