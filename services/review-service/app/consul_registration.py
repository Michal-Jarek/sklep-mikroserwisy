"""Rejestracja instancji w Consulu (D13): ID = INSTANCE_ID albo <usługa>-<hostname>, adres = własny IP,
check /health/ready co 10 s. Stan początkowy checku ("Status") wynika z pingu bazy: Consul robi pierwsze sprawdzenie
dopiero po czasie do jednego interwału, a bez "Status" instancja byłaby do tego czasu krytyczna (niewidoczna dla Gateway).

Co CHECK_INTERVAL sprawdzamy, czy wpis istnieje z aktualnym adresem i portem, a gdy go nie ma (Consul usunął
instancję po awarii bazy albo został zrestartowany), rejestrujemy się ponownie. Gdy Consul nie odpowiada: jedno
ostrzeżenie na awarię i próby po 1, 2, 4, 8, 15, 15 ... s. Usługa działa dalej bez Consula. Przy zatrzymaniu
(SIGTERM) instancja jest wyrejestrowywana.

Przy pierwszej rejestracji procesu (Z7) usuwamy też osierocone wpisy: ten sam adres i port, ale inne ID (compose:
kontener zabity bez wyrejestrowania i utworzony od nowa dostaje nowe ID i zwykle ten sam IP; stary wpis zostałby
w Consulu jako critical do DeregisterCriticalServiceAfter).
"""
import asyncio
import logging
import socket

import httpx

from app import db as database
from app.config import Settings

logger = logging.getLogger(__name__)

CHECK_INTERVAL = 15.0
RETRY_INITIAL = 1.0
RETRY_MAX = 15.0
CONSUL_TIMEOUT = 2.0


def own_address(consul_host: str, consul_port: int) -> str:
    """Własny adres IP na trasie do Consula (connect() na gnieździe UDP tylko wybiera trasę, nic nie wysyła).

    Nie nazwa usługi z compose (wszystkie instancje --scale miałyby ją wspólną) i nie pierwszy adres kontenera.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((consul_host, consul_port))
        address = sock.getsockname()[0]
    if address.startswith("127."):
        raise RuntimeError("trasa do Consula prowadzi przez adres pętli zwrotnej, ustaw SERVICE_ADDRESS")
    return address


class ConsulRegistrar:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        check_interval: float = CHECK_INTERVAL,
        retry_initial: float = RETRY_INITIAL,
        retry_max: float = RETRY_MAX,
    ):
        self.settings = settings
        self.base = f"http://{settings.consul_host}:{settings.consul_port}/v1/agent/service"
        self.health_url = f"http://{settings.consul_host}:{settings.consul_port}/v1/health/service/{settings.service_name}"
        self.service_id = settings.effective_instance_id
        self._transport = transport
        self._check_interval = check_interval
        self._retry_initial = retry_initial
        self._retry_max = retry_max

    async def _address(self) -> str:
        if self.settings.service_address:
            return self.settings.service_address
        # DNS w connect() blokuje, więc w wątku (najwyżej 2 s)
        return await asyncio.wait_for(
            asyncio.to_thread(own_address, self.settings.consul_host, self.settings.consul_port), CONSUL_TIMEOUT
        )

    async def _entry(self, client: httpx.AsyncClient) -> dict | None:
        resp = await client.get(f"{self.base}/{self.service_id}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    async def _is_registered(self, client: httpx.AsyncClient, address: str) -> bool:
        entry = await self._entry(client)
        # po restarcie to samo ID (ten sam hostname) może wskazywać stary adres
        return entry is not None and entry.get("Address") == address and entry.get("Port") == self.settings.service_port

    async def _register_at_start(self, client: httpx.AsyncClient, address: str) -> None:
        """Pierwsza rejestracja procesu.

        Wpis z tym samym ID może zostać po poprzednim procesie zabitym bez wyrejestrowania (compose: restart kontenera
        z tym samym hostname). Consul przy ponownej rejestracji zachowuje stan istniejącego checku (np. critical
        z czasu przerwy) i ignoruje "Status", więc taki wpis najpierw usuwamy. W Kubernetesie ID = nazwa poda,
        więc wpisu nie ma i nie ma też dodatkowego żądania.
        """
        await self._remove_orphans(client, address)
        if await self._entry(client) is not None:
            resp = await client.put(f"{self.base}/deregister/{self.service_id}")
            resp.raise_for_status()
            logger.info("Usunięto wpis poprzedniego procesu z Consula", extra={"fields": {"instanceId": self.service_id}})
        await self._register(client, address)

    async def _remove_orphans(self, client: httpx.AsyncClient, address: str) -> None:
        """Usuwa wpisy tej usługi z naszym adresem i portem, ale innym ID (poprzedni kontener na tym samym IP).

        Brak połączenia z Consulem przerywa próbę jak przy rejestracji (sprzątanie powtórzy się przy pierwszym udanym
        kontakcie). Błędna odpowiedź Consula (HTTP inny niż 2xx, zły JSON) to jedno ostrzeżenie: sprzątanie nie
        blokuje rejestracji.
        """
        try:
            resp = await client.get(self.health_url)
            resp.raise_for_status()
            orphans = [
                item["Service"]["ID"]
                for item in resp.json()
                if item["Service"]["Address"] == address
                and item["Service"]["Port"] == self.settings.service_port
                and item["Service"]["ID"] != self.service_id
            ]
        except httpx.TransportError:
            raise
        except Exception as exc:  # noqa: BLE001 - HTTP != 2xx, zły JSON albo nieoczekiwany format listy
            logger.warning(
                "Nie udało się usunąć osieroconych wpisów z Consula, rejestruję dalej",
                extra={"fields": {"reason": type(exc).__name__}},
            )
            return
        # odmowa przy jednej sierocie (np. 403, gdy Consul usunął ją w międzyczasie) nie przerywa pętli:
        # pozostałe sieroty i tak usuwamy, a nieudane dają jedno ostrzeżenie po pętli
        failed, reason = 0, None
        for orphan_id in orphans:
            resp = await client.put(f"{self.base}/deregister/{orphan_id}")
            if not resp.is_success:
                failed, reason = failed + 1, f"HTTP {resp.status_code}"
                continue
            logger.info("Usunięto osierocony wpis z Consula", extra={"fields": {"removedId": orphan_id}})
        if failed:
            logger.warning(
                "Nie udało się usunąć osieroconych wpisów z Consula, rejestruję dalej",
                extra={"fields": {"reason": reason, "failed": failed}},
            )

    async def _initial_status(self) -> str:
        try:
            await asyncio.wait_for(asyncio.to_thread(database.ping), CONSUL_TIMEOUT)
            return "passing"
        except Exception:  # noqa: BLE001 - także TimeoutError: baza nie odpowiada
            return "critical"

    async def _register(self, client: httpx.AsyncClient, address: str) -> None:
        s = self.settings
        status = await self._initial_status()
        resp = await client.put(
            f"{self.base}/register",
            json={
                "ID": self.service_id,
                "Name": s.service_name,
                "Address": address,
                "Port": s.service_port,
                "Check": {
                    "HTTP": f"http://{address}:{s.service_port}/health/ready",
                    "Interval": "10s",
                    "Timeout": "2s",
                    "DeregisterCriticalServiceAfter": "1m",
                    "Status": status,
                },
            },
        )
        resp.raise_for_status()
        logger.info(
            "Zarejestrowano w Consulu",
            extra={"fields": {"instanceId": self.service_id, "address": address, "checkStatus": status}},
        )

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=CONSUL_TIMEOUT, transport=self._transport) as client:
            reachable = True
            registered = False
            retry_in = self._retry_initial
            try:
                while True:
                    try:
                        address = await self._address()
                        if not registered:
                            await self._register_at_start(client, address)
                            registered = True
                        elif not await self._is_registered(client, address):
                            await self._register(client, address)
                        if not reachable:
                            reachable = True
                            logger.info("Consul znów dostępny")
                        retry_in = self._retry_initial
                        await asyncio.sleep(self._check_interval)
                    except Exception as exc:  # noqa: BLE001 - usługa działa dalej bez Consula
                        if reachable:
                            reachable = False
                            logger.warning(
                                "Consul niedostępny, ponowię rejestrację", extra={"fields": {"reason": type(exc).__name__}}
                            )
                        await asyncio.sleep(retry_in)
                        retry_in = min(retry_in * 2, self._retry_max)
            except asyncio.CancelledError:
                try:
                    resp = await client.put(f"{self.base}/deregister/{self.service_id}")
                    resp.raise_for_status()
                    logger.info("Wyrejestrowano z Consula", extra={"fields": {"instanceId": self.service_id}})
                except httpx.HTTPError:
                    logger.warning("Nie udało się wyrejestrować z Consula")
                raise
