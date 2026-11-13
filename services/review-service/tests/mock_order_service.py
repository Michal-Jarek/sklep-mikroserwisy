"""Atrapa Order Service do ręcznych testów (Postman) bez prawdziwego Ordera.

    python tests/mock_order_service.py          # nasłuchuje na :8086
    export ORDER_SERVICE_URL=http://localhost:8086 CONSUL_ENABLED=false

GET /orders/purchased?userId=&productId=  ->  {"purchased": true}, a dla productId=999 {"purchased": false}
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/orders/purchased":
            product = parse_qs(url.query).get("productId", [""])[0]
            body = {"purchased": product != "999"}
        elif url.path.startswith("/health"):
            body = {"status": "UP"}
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8086), Handler).serve_forever()
