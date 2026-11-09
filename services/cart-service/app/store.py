"""Wyłącznie persystencja: hash Redis, atomowy CAS i TTL siedmiu dni."""
from uuid import UUID
from redis.asyncio import Redis
from .schemas import Item

TTL_SECONDS = 7 * 24 * 60 * 60
CAS = """
local old = redis.call('HGET', KEYS[1], ARGV[1])
if (old or '') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
"""
REMOVE = """
local removed = redis.call('HDEL', KEYS[1], ARGV[1])
if removed == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return removed
"""

class CartStore:
    def __init__(self, redis: Redis):
        self.redis = redis

    def key(self, user_id: UUID) -> str:
        return f"cart:{user_id}"

    async def all(self, user_id: UUID) -> list[Item]:
        values = await self.redis.hgetall(self.key(user_id))
        return sorted((Item.model_validate_json(value) for value in values.values()), key=lambda item: str(item.product_id))

    async def raw(self, user_id: UUID, product_id: UUID) -> str | None:
        return await self.redis.hget(self.key(user_id), str(product_id))

    async def compare_and_set(self, user_id: UUID, product_id: UUID, old: str | None, item: Item) -> bool:
        result = await self.redis.eval(CAS, 1, self.key(user_id), str(product_id),
                                       old or "", item.model_dump_json(by_alias=True), TTL_SECONDS)
        return result == 1

    async def remove(self, user_id: UUID, product_id: UUID) -> None:
        await self.redis.eval(REMOVE, 1, self.key(user_id), str(product_id), TTL_SECONDS)

    async def clear(self, user_id: UUID) -> None:
        await self.redis.delete(self.key(user_id))

    async def ready(self) -> None:
        await self.redis.ping()
