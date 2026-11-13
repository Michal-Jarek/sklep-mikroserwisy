"""Demo catalog: the same categories and products (and the same UUIDs) as the frontend mocks
(frontend/src/mocks/seed.ts), so the shop shows the same data with the real service.
Images are not set (the mocks draw them in the browser). Remove with: alembic downgrade 0001."""
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

CATEGORIES = {
    "kitchen": ("c0000000-0000-4000-8000-000000000001", "Kuchnia"),
    "books": ("c0000000-0000-4000-8000-000000000002", "Książki"),
    "electronics": ("c0000000-0000-4000-8000-000000000003", "Elektronika"),
    "garden": ("c0000000-0000-4000-8000-000000000004", "Ogród"),
}

# (id, name, description, price, category)
PRODUCTS = [
    ("a0000000-0000-4000-8000-000000000001", 'Kubek ceramiczny', 'Kubek 300 ml, można myć w zmywarce.', "19.99", "kitchen"),
    ("a0000000-0000-4000-8000-000000000002", 'Czajnik elektryczny', 'Czajnik 1,7 l ze stali nierdzewnej.', "129.00", "kitchen"),
    ("a0000000-0000-4000-8000-000000000003", 'Deska do krojenia', 'Deska z drewna bukowego, 40 × 25 cm.', "49.90", "kitchen"),
    ("a0000000-0000-4000-8000-000000000004", 'Młynek do kawy', 'Ręczny młynek z żarnami ceramicznymi.', "89.99", "kitchen"),
    ("a0000000-0000-4000-8000-000000000005", 'Patelnia żeliwna', 'Patelnia 28 cm do kuchni indukcyjnej.', "159.00", "kitchen"),
    ("a0000000-0000-4000-8000-000000000006", 'Termos stalowy', 'Termos 750 ml, trzyma ciepło 12 godzin.', "59.99", "kitchen"),
    ("a0000000-0000-4000-8000-000000000007", 'Mikroserwisy w praktyce', 'Projektowanie i wdrażanie systemów z wielu usług.', "79.00", "books"),
    ("a0000000-0000-4000-8000-000000000008", 'Wzorce projektowe', 'Klasyczne wzorce z przykładami.', "99.00", "books"),
    ("a0000000-0000-4000-8000-000000000009", 'Czysty kod', 'Jak pisać kod czytelny dla innych.', "69.90", "books"),
    ("a0000000-0000-4000-8000-000000000010", 'Algorytmy', 'Algorytmy i struktury danych od podstaw.', "119.00", "books"),
    ("a0000000-0000-4000-8000-000000000011", 'Sieci komputerowe', 'Protokoły, adresacja i bezpieczeństwo sieci.', "89.00", "books"),
    ("a0000000-0000-4000-8000-000000000012", 'Bazy danych', 'Modelowanie danych i SQL.', "74.50", "books"),
    ("a0000000-0000-4000-8000-000000000013", 'Słuchawki bezprzewodowe', 'Słuchawki z redukcją szumów, 30 godzin pracy.', "249.99", "electronics"),
    ("a0000000-0000-4000-8000-000000000014", 'Mysz komputerowa', 'Mysz bezprzewodowa, 6 przycisków.', "59.00", "electronics"),
    ("a0000000-0000-4000-8000-000000000015", 'Klawiatura mechaniczna', 'Klawiatura z przełącznikami brązowymi.', "299.00", "electronics"),
    ("a0000000-0000-4000-8000-000000000016", 'Ładowarka USB-C', 'Ładowarka 65 W z jednym portem USB-C.', "39.99", "electronics"),
    ("a0000000-0000-4000-8000-000000000017", 'Powerbank 10000 mAh', 'Powerbank z szybkim ładowaniem.', "89.00", "electronics"),
    ("a0000000-0000-4000-8000-000000000018", 'Kabel HDMI 2 m', 'Kabel HDMI 2.1 o długości 2 m.', "24.99", "electronics"),
    ("a0000000-0000-4000-8000-000000000019", 'Konewka 10 l', 'Konewka z tworzywa z sitkiem.', "34.99", "garden"),
    ("a0000000-0000-4000-8000-000000000020", 'Sekator', 'Sekator nożycowy do gałęzi do 20 mm.', "54.90", "garden"),
    ("a0000000-0000-4000-8000-000000000021", 'Rękawice ogrodowe', 'Rękawice powlekane lateksem, rozmiar M.', "19.90", "garden"),
    ("a0000000-0000-4000-8000-000000000022", 'Leżak składany', 'Leżak z drewna akacjowego.', "149.00", "garden"),
    ("a0000000-0000-4000-8000-000000000023", 'Doniczka ceramiczna', 'Doniczka 18 cm z podstawką.', "29.99", "garden"),
    ("a0000000-0000-4000-8000-000000000024", 'Nasiona ziół', 'Zestaw nasion: bazylia, mięta, tymianek.', "9.99", "garden"),]

categories = sa.table("categories", sa.column("id", sa.Uuid()), sa.column("name", sa.String()))
products = sa.table(
    "products",
    sa.column("id", sa.Uuid()),
    sa.column("name", sa.String()),
    sa.column("description", sa.Text()),
    sa.column("price", sa.Numeric(10, 2)),
    sa.column("currency", sa.String()),
    sa.column("category_id", sa.Uuid()),
    sa.column("image_url", sa.String()),
    sa.column("created_at", sa.DateTime(timezone=True)),
    sa.column("updated_at", sa.DateTime(timezone=True)),
)


def upgrade():
    op.bulk_insert(categories, [{"id": uuid.UUID(i), "name": n} for i, n in CATEGORIES.values()])
    rows = []
    for number, (product_id, name, description, price, category) in enumerate(PRODUCTS):
        # Different creation times, so sort=NEWEST has a visible order (the last one is the newest).
        created = datetime(2026, 11, 1, 10, 0, tzinfo=UTC).replace(minute=number)
        rows.append({
            "id": uuid.UUID(product_id),
            "name": name,
            "description": description,
            "price": Decimal(price),
            "currency": "PLN",
            "category_id": uuid.UUID(CATEGORIES[category][0]),
            "image_url": None,
            "created_at": created,
            "updated_at": created,
        })
    op.bulk_insert(products, rows)


def downgrade():
    ids = [uuid.UUID(p[0]) for p in PRODUCTS]
    op.execute(products.delete().where(products.c.id.in_(ids)))
    # A demo category that still has products added later by an admin stays.
    used = sa.select(products.c.category_id).where(products.c.category_id == categories.c.id).exists()
    op.execute(categories.delete().where(
        categories.c.id.in_([uuid.UUID(i) for i, _ in CATEGORIES.values()]), ~used))
