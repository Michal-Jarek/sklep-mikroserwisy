"""Wzorcowe manifesty w k8s/: ustawienia, które psułyby konfigurację z Consul KV."""
from pathlib import Path

import yaml

K8S = Path(__file__).resolve().parent.parent / "k8s"


def test_configmap_does_not_set_log_level():
    # CR-16: LOG_LEVEL ma pierwszeństwo przed logLevel z Consul KV, więc we wzorze go nie ustawiamy
    data = yaml.safe_load((K8S / "configmap.yaml").read_text())["data"]
    assert "LOG_LEVEL" not in data
    assert data["SERVICE_NAME"] == "review-service" and data["CONSUL_ENABLED"] == "true"
