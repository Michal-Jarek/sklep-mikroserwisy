import logging

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.collection import Collection

logger = logging.getLogger(__name__)

# Opinie z productId jako UUID tekstem i _id jako UUID. Stara kolekcja "reviews" (productId liczbą, _id jako ObjectId)
# nie jest używana ani usuwana przez kod - usuwa ją platforma (deploy/README.md).
COLLECTION = "product_reviews"

# Każda operacja kończy się błędem najpóźniej po ~1,5 s, gdy baza nie odpowiada (wołający czekają 2 s):
# - wybór serwera 1 s (pymongo czeka w krokach do 0,5 s, więc w praktyce do ~1,5 s), nawiązanie połączenia 1 s;
# - brak odpowiedzi na otwartym połączeniu (baza zawieszona) 1,5 s;
# - bez ponowienia odczytu przez sterownik (retryReads), które podwajało czas przy zawieszonej bazie (3 s).
SERVER_SELECTION_TIMEOUT_MS = 1000
CONNECT_TIMEOUT_MS = 1000
SOCKET_TIMEOUT_MS = 1500


class _State:
    client: MongoClient | None = None
    database = None


def init_client(url: str, database: str) -> None:
    if not url:
        raise RuntimeError("Brak MONGODB_URL")
    _State.client = MongoClient(
        url,
        serverSelectionTimeoutMS=SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS=CONNECT_TIMEOUT_MS,
        socketTimeoutMS=SOCKET_TIMEOUT_MS,
        retryReads=False,
    )
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
