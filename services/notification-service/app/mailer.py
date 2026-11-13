"""E-mails: content from templates and sending through SMTP (Mailpit locally: no login, no TLS).

Event data partly comes from customers (e.g. firstName from the registration), so:
- the HTML part is rendered by Jinja2 with autoescape (a name like <a href=...> stays text),
- headers are set through email.message.EmailMessage, never glued together, and the subject
  contains no customer data (docs/events.md, "Czego nie robić").
"""

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import make_msgid

from jinja2 import Environment, StrictUndefined

from .config import Settings

SHIPPING_METHODS = {"COURIER": "kurier", "PARCEL_LOCKER": "paczkomat", "PICKUP": "odbiór osobisty"}

_html = Environment(autoescape=True, undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)
_text = Environment(autoescape=False, undefined=StrictUndefined, trim_blocks=True, lstrip_blocks=True)

LAYOUT = """\
<!doctype html>
<html lang="pl"><body style="font-family: Arial, sans-serif; color: #222; max-width: 560px">
<h2 style="color: #0d6a86">Sklep</h2>
{body}
<p style="color: #777; font-size: 12px">Wiadomość wysłana automatycznie, prosimy na nią nie odpowiadać.</p>
</body></html>
"""

TEMPLATES = {
    "welcome": {
        "subject": "Witamy w sklepie",
        "text": """\
Cześć {{ first_name }}!

Dziękujemy za założenie konta w naszym sklepie. Możesz już robić zakupy.

Pozdrawiamy,
Zespół sklepu
""",
        "html": """\
<p>Cześć {{ first_name }}!</p>
<p>Dziękujemy za założenie konta w naszym sklepie. Możesz już robić zakupy.</p>
<p>Pozdrawiamy,<br>Zespół sklepu</p>
""",
    },
    "order_created": {
        "subject": "Potwierdzenie zamówienia",
        "text": """\
Cześć {{ first_name }}!

Dziękujemy za zamówienie nr {{ order_number }}. Płatność została przyjęta.

{% for item in items %}
- {{ item.name }} x {{ item.quantity }} — {{ item.unitPrice }} {{ currency }}
{% endfor %}
Dostawa ({{ shipping_method }}): {{ shipping_cost }} {{ currency }}
Razem: {{ total }} {{ currency }}

Damy znać, gdy paczka zostanie wysłana.
""",
        "html": """\
<p>Cześć {{ first_name }}!</p>
<p>Dziękujemy za zamówienie nr <b>{{ order_number }}</b>. Płatność została przyjęta.</p>
<table cellpadding="4" style="border-collapse: collapse">
{% for item in items %}
<tr><td>{{ item.name }}</td><td>x {{ item.quantity }}</td>
<td align="right">{{ item.unitPrice }} {{ currency }}</td></tr>
{% endfor %}
<tr><td>Dostawa ({{ shipping_method }})</td><td></td><td align="right">{{ shipping_cost }} {{ currency }}</td></tr>
<tr><td><b>Razem</b></td><td></td><td align="right"><b>{{ total }} {{ currency }}</b></td></tr>
</table>
<p>Damy znać, gdy paczka zostanie wysłana.</p>
""",
    },
    "order_cancelled": {
        "subject": "Zamówienie anulowane",
        "text": """\
Cześć {{ first_name }}!

Zamówienie nr {{ order_number }} ({{ item_count }} szt.) zostało anulowane.
Jeśli płatność została pobrana, zwrot trafi na Twoje konto.
""",
        "html": """\
<p>Cześć {{ first_name }}!</p>
<p>Zamówienie nr <b>{{ order_number }}</b> ({{ item_count }} szt.) zostało anulowane.</p>
<p>Jeśli płatność została pobrana, zwrot trafi na Twoje konto.</p>
""",
    },
    "shipment_shipped": {
        "subject": "Twoja paczka jest w drodze",
        "text": """\
Cześć {{ first_name }}!

Zamówienie nr {{ order_number }} zostało wysłane.
{% if tracking_number %}Numer przesyłki: {{ tracking_number }}
{% endif %}
""",
        "html": """\
<p>Cześć {{ first_name }}!</p>
<p>Zamówienie nr <b>{{ order_number }}</b> zostało wysłane.</p>
{% if tracking_number %}<p>Numer przesyłki: <b>{{ tracking_number }}</b></p>{% endif %}
""",
    },
    "shipment_delivered": {
        "subject": "Paczka dostarczona",
        "text": """\
Cześć {{ first_name }}!

Zamówienie nr {{ order_number }} zostało dostarczone. Dziękujemy za zakupy!
Możesz ocenić kupione produkty na ich stronach w sklepie.
""",
        "html": """\
<p>Cześć {{ first_name }}!</p>
<p>Zamówienie nr <b>{{ order_number }}</b> zostało dostarczone. Dziękujemy za zakupy!</p>
<p>Możesz ocenić kupione produkty na ich stronach w sklepie.</p>
""",
    },
}


@dataclass(frozen=True)
class Mail:
    to: str
    subject: str
    text: str
    html: str


def render(template: str, to: str, **values) -> Mail:
    spec = TEMPLATES[template]
    text = _text.from_string(spec["text"]).render(**values)
    html = LAYOUT.format(body=_html.from_string(spec["html"]).render(**values))
    return Mail(to=to, subject=spec["subject"], text=text, html=html)


def build_message(mail: Mail, sender: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = mail.to  # EmailMessage rejects line breaks in headers
    message["Subject"] = mail.subject
    message["Message-ID"] = make_msgid(domain="sklep.local")
    message.set_content(mail.text)
    message.add_alternative(mail.html, subtype="html")
    return message


class SmtpMailer:
    def __init__(self, settings: Settings):
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.sender = settings.mail_from

    async def send(self, mail: Mail) -> None:
        """Raises on any SMTP or network error: the consumer then tries the event again."""
        message = build_message(mail, self.sender)

        def deliver() -> None:
            with smtplib.SMTP(self.host, self.port, timeout=5) as smtp:
                smtp.send_message(message)

        await asyncio.to_thread(deliver)
