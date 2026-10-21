-- ============================================================
-- Orvix POS Database Schema (historical pre-050 snapshot; see supabase/baseline/README.md)
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- shops
CREATE TABLE IF NOT EXISTS shops (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  address text NOT NULL,
  phone text,
  email text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shops_unique_normalized_name
  ON shops ((lower(btrim(name))));

CREATE UNIQUE INDEX IF NOT EXISTS shops_unique_normalized_code
  ON shops ((lower(btrim(code))))
  WHERE NULLIF(btrim(code), '') IS NOT NULL;

-- users (staff profiles — linked to Supabase auth.users via auth_id)
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  role text NOT NULL,
  shop_id text REFERENCES shops(id),
  auth_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  permissions text[],            -- deprecated legacy replacement model
  granted_permissions text[],    -- additive grants on top of role defaults
  revoked_permissions text[],    -- explicit denials (win over default + grant)
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- NOTE: existing databases must run, in order, the files in supabase/migrations/:
--   001_identity_linking.sql, 002_rbac_permissions.sql, 003_identity_rls_helpers.sql

-- categories
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  color text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- products
CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  sku text,
  name text NOT NULL,
  category text NOT NULL,
  unit_type text NOT NULL,
  price_mmk integer NOT NULL,
  cost_mmk integer,
  pack_size integer,
  low_stock_threshold integer NOT NULL DEFAULT 0,
  expiry_date text,
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- product_units (product-specific sellable units; stock remains in base units)
CREATE TABLE IF NOT EXISTS product_units (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_quantity integer NOT NULL CHECK (base_quantity > 0),
  sale_price_mmk integer NOT NULL CHECK (sale_price_mmk >= 0),
  purchase_price_mmk integer CHECK (purchase_price_mmk IS NULL OR purchase_price_mmk >= 0),
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_units_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_units_unique_active_name
  ON product_units (product_id, (lower(btrim(name))))
  WHERE is_active;

CREATE UNIQUE INDEX IF NOT EXISTS product_units_one_default
  ON product_units (product_id)
  WHERE is_default;

-- product_barcodes
CREATE TABLE IF NOT EXISTS product_barcodes (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_unit_id text REFERENCES product_units(id) ON DELETE SET NULL,
  value text NOT NULL,
  type text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS product_barcodes_unique_normalized_value
  ON product_barcodes ((lower(btrim(value))))
  WHERE NULLIF(btrim(value), '') IS NOT NULL;

-- price_tiers
CREATE TABLE IF NOT EXISTS price_tiers (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id text REFERENCES shops(id),
  min_qty integer NOT NULL,
  max_qty integer,
  price_mmk integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

-- inventory (composite PK per shop+product)
CREATE TABLE IF NOT EXISTS inventory (
  shop_id text NOT NULL REFERENCES shops(id),
  product_id text NOT NULL REFERENCES products(id),
  qty_base_units integer NOT NULL DEFAULT 0,
  storage_location text,
  last_counted_at timestamptz,
  PRIMARY KEY (shop_id, product_id)
);

-- inventory_movements (full ledger)
CREATE TABLE IF NOT EXISTS inventory_movements (
  id text PRIMARY KEY,
  shop_id text NOT NULL,
  product_id text NOT NULL,
  type text NOT NULL,
  qty_change integer NOT NULL,
  qty_before integer NOT NULL,
  qty_after integer NOT NULL,
  reason text NOT NULL,
  reference_type text,
  reference_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  product_unit_id text REFERENCES product_units(id) ON DELETE SET NULL,
  unit_name_snapshot text,
  unit_base_quantity_snapshot integer,
  selected_unit_quantity integer
);

-- suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  contact_person text,
  phone text,
  email text,
  address text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- purchase_orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id text PRIMARY KEY,
  order_no text NOT NULL,
  shop_id text NOT NULL,
  supplier_id text NOT NULL,
  status text NOT NULL,
  subtotal_mmk integer NOT NULL,
  tax_mmk integer,
  total_mmk integer NOT NULL,
  paid_mmk integer NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'UNPAID',
  supplier_invoice_no text,
  delivery_note_no text,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  received_by text,
  received_at timestamptz
);

-- purchase_order_items
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id text PRIMARY KEY,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  ordered_qty integer NOT NULL,
  received_qty integer,
  unit_cost_mmk integer NOT NULL,
  line_total_mmk integer NOT NULL,
  product_unit_id text REFERENCES product_units(id) ON DELETE SET NULL,
  unit_name_snapshot text,
  unit_base_quantity_snapshot integer,
  selected_unit_quantity integer,
  unit_purchase_price_snapshot integer
);

-- supplier_payments
CREATE TABLE IF NOT EXISTS supplier_payments (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id),
  shop_id text NOT NULL REFERENCES shops(id),
  amount_mmk integer NOT NULL CHECK (amount_mmk > 0),
  payment_method text NOT NULL,
  reference_no text,
  notes text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by text REFERENCES users(id),
  void_reason text
);

-- stock_transfers
CREATE TABLE IF NOT EXISTS stock_transfers (
  id text PRIMARY KEY,
  transfer_no text NOT NULL,
  from_shop_id text NOT NULL,
  to_shop_id text NOT NULL,
  status text NOT NULL,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  completed_at timestamptz,
  canceled_by text,
  canceled_at timestamptz,
  cancel_reason text
);

-- stock_transfer_items
CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id text PRIMARY KEY,
  transfer_id text NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  requested_qty integer NOT NULL,
  approved_qty integer,
  transferred_qty integer,
  product_unit_id text REFERENCES product_units(id) ON DELETE SET NULL,
  unit_name_snapshot text,
  unit_base_quantity_snapshot integer,
  selected_unit_quantity integer
);

-- shifts
CREATE TABLE IF NOT EXISTS shifts (
  id text PRIMARY KEY,
  shop_id text NOT NULL,
  cashier_id text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  opening_cash_mmk integer NOT NULL,
  closing_cash_mmk integer,
  expected_cash_mmk integer,
  variance_mmk integer,
  variance_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_cashier_shop
  ON shifts (cashier_id, shop_id)
  WHERE ended_at IS NULL;

-- sales
CREATE TABLE IF NOT EXISTS sales (
  id text PRIMARY KEY,
  shop_id text NOT NULL,
  shift_id text NOT NULL,
  receipt_no text NOT NULL,
  cashier_id text NOT NULL,
  status text NOT NULL DEFAULT 'NORMAL',
  subtotal_mmk integer NOT NULL,
  discount_mmk integer NOT NULL DEFAULT 0,
  cart_discount_pct numeric,
  total_mmk integer NOT NULL,
  payment_method text NOT NULL,
  paid_mmk integer NOT NULL,
  change_mmk integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- sale_items
CREATE TABLE IF NOT EXISTS sale_items (
  id text PRIMARY KEY,
  sale_id text NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  product_unit_id text REFERENCES product_units(id) ON DELETE SET NULL,
  qty_units integer NOT NULL,
  unit_price_mmk integer NOT NULL,
  item_discount_pct numeric,
  line_total_mmk integer NOT NULL,
  price_overridden_by text,
  unit_label text,
  units_per_item integer,
  unit_name_snapshot text,
  unit_base_quantity_snapshot integer,
  unit_price_mmk_snapshot integer,
  base_quantity_sold integer,
  stock_override_by text
);

-- reprint_logs
CREATE TABLE IF NOT EXISTS reprint_logs (
  id text PRIMARY KEY,
  sale_id text NOT NULL REFERENCES sales(id),
  printed_by text NOT NULL,
  printed_at timestamptz NOT NULL DEFAULT now()
);

-- refund_void_requests
CREATE TABLE IF NOT EXISTS refund_void_requests (
  id text PRIMARY KEY,
  sale_id text NOT NULL,
  shop_id text NOT NULL,
  type text NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  items jsonb,
  status text NOT NULL DEFAULT 'REQUESTED'
);

-- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  shop_id text,
  actor_id text NOT NULL,
  action_type text NOT NULL,
  message text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Row Level Security (authenticated users can access all data)
-- ============================================================

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprint_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_void_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users full access (app enforces its own RBAC)
CREATE POLICY "authenticated_all" ON shops FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON users FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON categories FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON products FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON product_units FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON product_barcodes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON price_tiers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON inventory FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON inventory_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON suppliers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON purchase_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON purchase_order_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON supplier_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON stock_transfers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON stock_transfer_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON shifts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON sales FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON sale_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON reprint_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON refund_void_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "authenticated_all" ON audit_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
