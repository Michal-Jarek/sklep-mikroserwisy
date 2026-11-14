"""Rejestracja instancji w Consulu (D13): ID <usługa>-<hostname>, adres = własny IP, check /health/ready co 10 s.

Co CHECK_INTERVAL sprawdzamy, czy wpis istnieje z aktualnym adresem i portem, a gdy go nie ma (Consul usunął
instancję po awarii bazy albo został zrestartowany), rejestrujemy się ponownie. Gdy Consul nie odpowiada: jedno
ostrzeżenie na awarię i próby po 1, 2, 4, 8, 15, 15 ... s. Usługa działa dalej bez Consula. Przy zatrzymaniu
(SIGTERM) instancja jest wyrejestrowywana.
"""
import asyncio
import logging
import socket

import httpx

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

    async def _is_registered(self, client: httpx.AsyncClient, address: str) -> bool:
        resp = await client.get(f"{self.base}/{self.service_id}")
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
        entry = resp.json()
        # po restarcie to samo ID (ten sam hostname) może wskazywać stary adres
        return entry.get("Address") == address and entry.get("Port") == self.settings.service_port

    async def _register(self, client: httpx.AsyncClient, address: str) -> None:
        s = self.settings
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
                },
            },
        )
        resp.raise_for_status()
        logger.info("Zarejestrowano w Consulu", extra={"fields": {"instanceId": self.service_id, "address": address}})

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=CONSUL_TIMEOUT, transport=self._transport) as client:
            reachable = True
            retry_in = self._retry_initial
            try:
                while True:
                    try:
                        address = await self._address()
                        if not await self._is_registered(client, address):
                            await self._register(client, address)
                        if not reachable:
                            reachable = True
                            logger.info("Consul znów dostępny")
                        retry_in = self._retry_initial
                        await asyncio.sleep(self._check_interval)
                    except Exception as exc:  
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
