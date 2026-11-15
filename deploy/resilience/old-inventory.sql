-- K14 case olddb: inventory_db as the old Inventory code (before PR #18 fixes) left it: product_id BIGINT.
-- Schema as \d showed the tables created by the old code (stage 8, task T1). The role has no password here:
-- run.sh sets a random one for every run (ALTER ROLE with the psql variable :'pw' from the container environment).
CREATE ROLE inventory_service LOGIN;
CREATE DATABASE inventory_db OWNER inventory_service;
\connect inventory_db
SET ROLE inventory_service;
CREATE TABLE inventory_items (
  product_id bigint PRIMARY KEY,
  quantity integer NOT NULL,
  reserved integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ck_inventory_quantity_nonneg CHECK (quantity >= 0),
  CONSTRAINT ck_inventory_reserved_le_quantity CHECK (reserved <= quantity),
  CONSTRAINT ck_inventory_reserved_nonneg CHECK (reserved >= 0)
);
CREATE TABLE reservations (
  id serial PRIMARY KEY,
  order_id varchar(64) NOT NULL,
  product_id bigint NOT NULL,
  quantity integer NOT NULL,
  status varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT uq_reservation_order_product UNIQUE (order_id, product_id)
);
CREATE INDEX ix_reservations_order_id ON reservations (order_id);
INSERT INTO inventory_items (product_id, quantity, reserved, updated_at) VALUES (12, 10, 2, now());
INSERT INTO reservations (order_id, product_id, quantity, status, created_at) VALUES ('old-ord-1', 12, 2, 'ACTIVE', now());
