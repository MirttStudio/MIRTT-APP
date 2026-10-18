-- ============================================================================
-- MIRTT WEAR — Full cloud schema (public schema, Supabase Postgres)
--
-- اعملها مرة واحدة في Supabase → SQL Editor → New query → الصق الملف كله → Run
-- بعد ما يخلص: افتح Mirrt Manager → Settings → "Move to cloud storage" → Sync
--
-- Idempotent: safe to re-run (DO-blocks for enums, IF NOT EXISTS everywhere).
-- Covers everything the storefront + Mirrt Manager actually use today:
--   profiles, catalog (collections/products/variants/images/links), orders +
--   order_items, reviews, coupons, pages_content, site_settings,
--   campaign_banners, analytics (sessions + events), abandoned carts,
--   back-in-stock alerts, audit log — plus the three RPCs the site calls
--   (create_mirtt_order / validate_coupon / track_order) and the public
--   "product-images" storage bucket.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type order_status as enum ('pending','confirmed','preparing','shipped','delivered','completed','cancelled','returned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type product_status as enum ('available','hidden');
exception when duplicate_object then null; end $$;

do $$ begin
  create type coupon_type as enum ('percentage','fixed');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) Tables
-- ---------------------------------------------------------------------------

-- Manager accounts (mirrors Supabase auth users; login requires an active row)
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text not null default 'staff' check (role in ('admin','staff')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Catalog -------------------------------------------------------------------
create table if not exists collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  cover_image text,
  is_visible  boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists products (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  description         text,
  category            text,
  subcategory         text,
  gender              text,
  collection_id       uuid references collections(id) on delete set null,
  sku                 text,
  image_url           text,
  price               numeric(10,2) not null default 0 check (price >= 0),
  sale_price          numeric(10,2) check (sale_price is null or sale_price >= 0),
  discount_active     boolean not null default false,
  status              product_status not null default 'available',
  is_featured         boolean not null default false,
  care_details        text,
  shipping_info       text,
  return_info         text,
  size_chart_url      text,
  size_type           text,
  low_stock_threshold integer not null default 0,
  stock_total         integer not null default 0,
  stock_from_colors   boolean not null default false,
  created_at          timestamptz not null default now()
);

-- Task 195 — size labels + the headline stock figure.
--   size_type   = 'letters' (S/M/L/XL tops) | 'numbers' (28–38 bottoms).
--                 null ⇒ the storefront falls back to the category default.
--   stock_total = the "Available quantity" shown on the Manager product card —
--                 the sum of every colour/size stock, kept in step as orders land.
-- Idempotent ALTERs so a database created from an earlier revision also gets them.
alter table products add column if not exists image_url text;
alter table products add column if not exists size_type text;
alter table products add column if not exists stock_total integer not null default 0;
do $$ begin
  alter table products add constraint products_size_type_chk
    check (size_type is null or size_type in ('letters','numbers'));
exception when duplicate_object then null; end $$;

-- Per-size stock lives here: one row per colour × size (color_name + size +
-- stock) is exactly the Manager's colour grid, so no extra column is needed —
-- the grid writes/reads these rows (color_hex carries the swatch).
create table if not exists product_variants (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  color_name text,
  color_hex  text,
  size       text,
  stock      integer not null default 0 check (stock >= 0),
  sku        text,
  created_at timestamptz not null default now()
);

create table if not exists product_images (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  color_name text,
  url        text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- many-to-many: which products live in which collection page
create table if not exists product_collections (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  collection_id uuid not null references collections(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (product_id, collection_id)
);

-- Orders --------------------------------------------------------------------
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique,
  customer_name    text not null,
  phone            text not null,
  email            text,
  address          text not null,
  governorate      text not null,
  city             text not null,
  notes            text,
  status           order_status not null default 'pending',
  is_read          boolean not null default false,
  label_printed_at timestamptz,
  payment_method   text not null default 'cod',
  subtotal         numeric(10,2) not null default 0,
  shipping_fee     numeric(10,2) not null default 0,
  shipping_method  text not null default 'standard',
  coupon_code      text,
  discount_amount  numeric(10,2) not null default 0,
  offer_discount   numeric(10,2) not null default 0,
  offer_titles     jsonb not null default '[]'::jsonb,
  total            numeric(10,2) not null default 0,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  created_at       timestamptz not null default now()
);
-- Task 113: express shipping — remember which delivery option the customer
-- chose ('standard' | 'express'). Idempotent so re-running the file is safe
-- (fresh installs already include the column through the default above —
-- legacy databases get it through this ALTER).
alter table orders add column if not exists shipping_method text not null default 'standard';
-- Task 189: automatic bundle offers stamp their saving + titles onto the order.
-- Task 194: payment_method records how the order is settled (COD today).
alter table orders add column if not exists payment_method text not null default 'cod';
alter table orders add column if not exists offer_discount numeric(10,2) not null default 0;
alter table orders add column if not exists offer_titles jsonb not null default '[]'::jsonb;

create table if not exists order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete cascade,
  product_id            uuid references products(id) on delete set null,
  variant_id            uuid,
  product_name_snapshot text not null,
  color_name            text,
  size                  text,
  quantity              integer not null check (quantity > 0),
  unit_price            numeric(10,2) not null default 0,
  line_total            numeric(10,2) not null default 0,
  created_at            timestamptz not null default now()
);

-- Reviews (customer submissions start unapproved; Manager approves) ----------
create table if not exists product_reviews (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  customer_name text not null,
  rating        integer not null check (rating between 1 and 5),
  comment       text,
  is_approved   boolean not null default false,
  is_read       boolean not null default false,
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Coupons -------------------------------------------------------------------
create table if not exists coupons (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  type             coupon_type not null default 'percentage',
  value            numeric(10,2) not null default 0 check (value >= 0),
  min_order_amount numeric(10,2) not null default 0,
  usage_limit      integer,
  times_used       integer not null default 0,
  starts_at        timestamptz,
  ends_at          timestamptz,
  is_active        boolean not null default true,
  product_ids      jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);
alter table coupons add column if not exists product_ids jsonb not null default '[]'::jsonb;

-- Site content --------------------------------------------------------------
create table if not exists pages_content (
  id          uuid primary key default gen_random_uuid(),
  page_key    text not null,
  section_key text not null,
  content     jsonb not null default '{}'::jsonb,
  sort_order  integer not null default 1,
  updated_at  timestamptz not null default now(),
  unique (page_key, section_key)
);

create table if not exists site_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists campaign_banners (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  image_url  text not null default '',
  cta_text   text,
  cta_link   text,
  placement  text not null default 'home_hero',   -- home_hero | announcement_bar
  starts_at  timestamptz,
  ends_at    timestamptz,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Automatic bundle offers (Manager ▸ Website ▸ Offers) -----------------------
-- Applied to the cart automatically at checkout (no code): buy X get Y free,
-- or every group of X, the cheaper (X−1) pieces get `percent`% off.
-- product_ids = [] / null ⇒ the offer covers the whole catalogue.
create table if not exists offers (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  type          text not null default 'buy_x_get_y'
                  check (type in ('buy_x_get_y','second_item_discount')),
  product_ids   jsonb not null default '[]'::jsonb,
  buy_quantity  integer not null default 2,
  free_quantity integer not null default 1,
  percent       numeric(5,2) not null default 0 check (percent >= 0 and percent <= 100),
  is_active     boolean not null default true,
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_at    timestamptz not null default now()
);
alter table offers add column if not exists percent numeric(5,2) not null default 0;

-- Timed drops / capsules (Manager ▸ Drops) ---------------------------------
create table if not exists drops (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  slug             text not null unique,
  description      text,
  cover_image      text,
  product_ids      jsonb not null default '[]'::jsonb,
  starts_at        timestamptz,
  ends_at          timestamptz,
  discount_percent numeric(5,2) not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  is_visible       boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Analytics -----------------------------------------------------------------
create table if not exists analytics_sessions (
  id              uuid primary key default gen_random_uuid(),
  session_id      text not null unique,             -- client-generated UUID
  entry_page      text,
  exit_page       text,
  device_type     text,                             -- mobile | tablet | desktop
  viewport_width  integer,
  referrer        text,
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  geo_governorate text,                             -- filled when known (map view)
  geo_city        text,
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create table if not exists analytics_events (
  id           uuid primary key default gen_random_uuid(),
  session_id   text,
  client_id    text unique,                         -- id of the local-mode row this was migrated from (sync dedupe)
  event_type   text not null,                       -- page_view | product_view | add_to_cart | checkout_initiated | purchase | site_search
  page_path    text,
  product_id   text,
  order_id     text,
  search_query text,
  created_at   timestamptz not null default now()
);

-- Recovery tools ------------------------------------------------------------
create table if not exists abandoned_carts (
  id               uuid primary key default gen_random_uuid(),
  session_id       text,
  customer_name    text,
  customer_phone   text,
  customer_email   text,
  cart_items       jsonb not null default '[]'::jsonb,
  subtotal         numeric(10,2) not null default 0,
  status           text not null default 'active',  -- active | recovered | reminded
  order_id         uuid,
  reminder_sent_at timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create table if not exists back_in_stock_subscriptions (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  variant_id     uuid references product_variants(id) on delete cascade,
  customer_email text not null,
  customer_phone text,
  notified       boolean not null default false,
  created_at     timestamptz not null default now()
);

create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_email text,
  action      text not null,
  table_name  text,
  record_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3) Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_products_status on products (status);
create index if not exists idx_products_collection on products (collection_id);
create index if not exists idx_variants_product on product_variants (product_id);
-- colour × size lookup for the per-size stock grid (Manager product editor)
create index if not exists idx_variants_product_size on product_variants (product_id, color_name, size);
create index if not exists idx_images_product on product_images (product_id, sort_order);
create index if not exists idx_pc_product on product_collections (product_id);
create index if not exists idx_pc_collection on product_collections (collection_id);
create index if not exists idx_orders_created on orders (created_at desc);
create index if not exists idx_orders_phone on orders (phone);
create index if not exists idx_orders_status on orders (status);
create index if not exists idx_order_items_order on order_items (order_id);
create index if not exists idx_reviews_product on product_reviews (product_id, is_approved);
create index if not exists idx_pages_page on pages_content (page_key, sort_order);
create index if not exists idx_banners_placement on campaign_banners (placement, is_active);
create index if not exists idx_offers_active on offers (is_active, starts_at, ends_at);
create index if not exists idx_drops_slug on drops (slug, is_visible);
create index if not exists idx_events_created on analytics_events (created_at desc);
create index if not exists idx_events_type on analytics_events (event_type);
create index if not exists idx_events_session on analytics_events (session_id);
create index if not exists idx_events_client on analytics_events (client_id);
create index if not exists idx_sessions_last_seen on analytics_sessions (last_seen_at desc);
create index if not exists idx_carts_activity on abandoned_carts (last_activity_at desc);
-- one alert per product+variant+email (case-insensitive) — the API treats a
-- unique violation (23505) as "already registered"
create unique index if not exists uq_back_in_stock
  on back_in_stock_subscriptions (product_id, variant_id, lower(customer_email));

-- ---------------------------------------------------------------------------
-- 4) Order-number sequence + updated_at touch
-- ---------------------------------------------------------------------------
create sequence if not exists mirtt_order_seq start 100000;

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists pages_content_touch on pages_content;
create trigger pages_content_touch before update on pages_content
  for each row execute function touch_updated_at();

drop trigger if exists site_settings_touch on site_settings;
create trigger site_settings_touch before update on site_settings
  for each row execute function touch_updated_at();

drop trigger if exists drops_touch on drops;
create trigger drops_touch before update on drops
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5) RPC: validate_coupon(p_code, p_cart_items)
--    Called with the publishable key from /api/coupon. Read-only.
--    p_cart_items: [{"product_id":"…","line_total":123.00}, …]
-- ---------------------------------------------------------------------------
create or replace function validate_coupon(
  p_code       text,
  p_cart_items jsonb default '[]'::jsonb
)
returns table (valid boolean, message text, discount_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_coupon     record;
  v_cart_total numeric(10,2) := 0;
  v_item       jsonb;
  v_discount   numeric(10,2);
  v_eligible   numeric(10,2) := 0;
begin
  if p_code is null or btrim(p_code) = '' then
    return query select false, 'Enter a coupon code.', 0::numeric; return;
  end if;
  if p_cart_items is not null and jsonb_typeof(p_cart_items) = 'array' then
    for v_item in select * from jsonb_array_elements(p_cart_items) loop
      v_cart_total := v_cart_total + coalesce((v_item->>'line_total')::numeric, 0);
    end loop;
  end if;

  select * into v_coupon from coupons c where c.code = upper(btrim(p_code));
  if not found then
    return query select false, 'This coupon code does not exist.', 0::numeric; return;
  end if;
  if not v_coupon.is_active then
    return query select false, 'This coupon is no longer active.', 0::numeric; return;
  end if;
  if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
    return query select false, 'This coupon is not active yet.', 0::numeric; return;
  end if;
  if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
    return query select false, 'This coupon has expired.', 0::numeric; return;
  end if;
  if v_cart_total < v_coupon.min_order_amount then
    return query select false,
      'This coupon needs a minimum order of EGP ' || to_char(v_coupon.min_order_amount, 'FM999999990.00') || '.',
      0::numeric; return;
  end if;
  if v_coupon.usage_limit is not null and v_coupon.times_used >= v_coupon.usage_limit then
    return query select false, 'This coupon has reached its usage limit.', 0::numeric; return;
  end if;

  -- Per-product restriction: when the coupon is switched on for specific
  -- products (Manager → Coupons), only those items count toward the discount.
  if v_coupon.product_ids is not null and jsonb_typeof(v_coupon.product_ids) = 'array'
     and jsonb_array_length(v_coupon.product_ids) > 0 then
    for v_item in select * from jsonb_array_elements(p_cart_items) loop
      if v_coupon.product_ids ? (v_item->>'product_id') then
        v_eligible := v_eligible + coalesce((v_item->>'line_total')::numeric, 0);
      end if;
    end loop;
    if v_eligible <= 0 then
      return query select false, 'This coupon does not apply to the items in your bag.', 0::numeric; return;
    end if;
    v_cart_total := v_eligible;
  end if;

  v_discount := case
    when v_coupon.type = 'percentage' then round(v_cart_total * v_coupon.value / 100.0, 2)
    else least(v_coupon.value, v_cart_total)
  end;
  return query select true, 'Coupon applied.', v_discount;
end $$;

-- ---------------------------------------------------------------------------
-- 6) RPC: create_mirtt_order(...) — server-side checkout (secret key only).
--    Locks stock, validates phone/products/coupon, computes shipping from
--    site_settings 'shipping_fees' ({cairo,giza,alexandria,other,express,free_over}), writes
--    the order + snapshot items, decrements stock and returns the order.
--    Errors surface as messages the API maps: invalid_phone,
--    product_unavailable, insufficient_stock, coupon_rejected.
-- ---------------------------------------------------------------------------
create or replace function create_mirtt_order(
  p_customer_name text,
  p_phone         text,
  p_email         text,
  p_address       text,
  p_governorate   text,
  p_city          text,
  p_notes         text,
  p_lines         jsonb,
  p_coupon_code   text,
  p_utm_source    text,
  p_utm_medium    text,
  p_utm_campaign  text,
  -- Task 113: 'standard' (zone fee, default) or 'express' (flat nationwide
  -- fee from shipping_fees.express). Optional with a default so the legacy
  -- 12-argument call sites keep working beside the new signature.
  p_shipping_method text default 'standard'
)
returns table (order_id uuid, order_number text, total numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_order_id   uuid;
  v_number     text;
  v_subtotal   numeric(10,2) := 0;
  v_shipping   numeric(10,2);
  v_free_over  numeric(10,2);
  v_discount   numeric(10,2) := 0;
  v_total      numeric(10,2);
  v_rates      jsonb;
  v_line       jsonb;
  v_qty        integer;
  v_variant    product_variants%rowtype;
  v_product    products%rowtype;
  v_unit       numeric(10,2);
  v_line_total numeric(10,2);
  v_coupon     coupons%rowtype;
  v_items      jsonb := '[]'::jsonb;
  v_it         jsonb;
  v_vid        uuid;
  v_eligible   numeric(10,2) := 0;
  v_ptotals    jsonb := '{}'::jsonb;
  v_key        text;
begin
  if p_phone is null or p_phone !~ '^01[0125][0-9]{8}$' then
    raise exception 'invalid_phone';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'invalid_lines';
  end if;
  if p_customer_name is null or btrim(p_customer_name) = ''
     or p_address is null or btrim(p_address) = ''
     or p_governorate is null or btrim(p_governorate) = ''
     or p_city is null or btrim(p_city) = '' then
    raise exception 'invalid_details';
  end if;

  -- shipping fee — same zones the storefront shows (defaults mirror the UI).
  -- 'express' (Task 113) is a flat nationwide price the owner sets in the
  -- Manager; it replaces the zone fee when the customer picks it.
  select s.value into v_rates from site_settings s where s.key = 'shipping_fees';
  if v_rates is null or jsonb_typeof(v_rates) <> 'object' then
    v_rates := '{"cairo":30,"giza":35,"alexandria":40,"other":50,"express":120}'::jsonb;
  end if;
  v_shipping := case p_governorate
    when 'Cairo'      then coalesce((v_rates->>'cairo')::numeric, 30)
    when 'Giza'       then coalesce((v_rates->>'giza')::numeric, 35)
    when 'Alexandria' then coalesce((v_rates->>'alexandria')::numeric, 40)
    else coalesce((v_rates->>'other')::numeric, 50)
  end;
  if coalesce(p_shipping_method, 'standard') = 'express' then
    v_shipping := greatest(coalesce((v_rates->>'express')::numeric, 120), 0);
  end if;

  -- validate + lock every line, build the item snapshot list
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_qty := (v_line->>'quantity')::int;
    if v_qty is null or v_qty < 1 or v_qty > 10 then raise exception 'invalid_lines'; end if;
    if v_line->>'variant_id' is null then raise exception 'invalid_lines'; end if;

    select * into v_variant from product_variants pv
      where pv.id = (v_line->>'variant_id')::uuid for update;
    if not found then raise exception 'product_unavailable'; end if;

    select * into v_product from products p
      where p.id = v_variant.product_id for update;
    if not found or v_product.status <> 'available' then raise exception 'product_unavailable'; end if;
    if v_variant.stock < v_qty then raise exception 'insufficient_stock'; end if;

    v_unit := case when v_product.discount_active and v_product.sale_price is not null
                   then v_product.sale_price else v_product.price end;
    v_line_total := round(v_unit * v_qty, 2);
    v_subtotal   := v_subtotal + v_line_total;
    v_ptotals := jsonb_set(v_ptotals, ARRAY[v_product.id::text],
      to_jsonb(coalesce((v_ptotals->>(v_product.id::text))::numeric, 0) + v_line_total));

    v_items := v_items || jsonb_build_object(
      'variant_id', v_variant.id,
      'product_id', v_product.id,
      'name',       v_product.name,
      'color_name', v_variant.color_name,
      'size',       v_variant.size,
      'quantity',   v_qty,
      'unit_price', v_unit,
      'line_total', v_line_total
    );
  end loop;

  -- coupon (locked so two checkouts cannot overspend the same limit)
  if p_coupon_code is not null and btrim(p_coupon_code) <> '' then
    select * into v_coupon from coupons c where c.code = upper(btrim(p_coupon_code)) for update;
    if not found then raise exception 'coupon_rejected'; end if;
    if not v_coupon.is_active then raise exception 'coupon_rejected'; end if;
    if v_coupon.starts_at is not null and now() < v_coupon.starts_at then raise exception 'coupon_rejected'; end if;
    if v_coupon.ends_at is not null and now() > v_coupon.ends_at then raise exception 'coupon_rejected'; end if;
    if v_subtotal < v_coupon.min_order_amount then raise exception 'coupon_rejected'; end if;
    if v_coupon.usage_limit is not null and v_coupon.times_used >= v_coupon.usage_limit then raise exception 'coupon_rejected'; end if;
    -- per-product restriction (Manager → Coupons switches)
    v_eligible := v_subtotal;
    if v_coupon.product_ids is not null and jsonb_typeof(v_coupon.product_ids) = 'array'
       and jsonb_array_length(v_coupon.product_ids) > 0 then
      v_eligible := 0;
      for v_key in select jsonb_object_keys(v_ptotals) loop
        if v_coupon.product_ids ? v_key then
          v_eligible := v_eligible + coalesce((v_ptotals->>v_key)::numeric, 0);
        end if;
      end loop;
      if v_eligible <= 0 then raise exception 'coupon_rejected'; end if;
    end if;
    v_discount := case
      when v_coupon.type = 'percentage' then round(v_eligible * v_coupon.value / 100.0, 2)
      else least(v_coupon.value, v_eligible)
    end;
    update coupons c set times_used = c.times_used + 1 where c.id = v_coupon.id;
  end if;

  -- free shipping — set from the Manager (Settings → Shipping fees as
  -- 'shipping_fees.free_over', default 1500, 0 = disabled). Applied on the
  -- net order (subtotal − discount) so the COD total matches the storefront.
  -- Standard option only — express keeps its own flat price (Task 113).
  v_free_over := coalesce((v_rates->>'free_over')::numeric, 1500);
  if coalesce(p_shipping_method, 'standard') <> 'express'
     and v_free_over > 0 and greatest(v_subtotal - v_discount, 0) >= v_free_over then
    v_shipping := 0;
  end if;

  v_total := greatest(v_subtotal - v_discount, 0) + v_shipping;
  v_number := 'MRT-' || nextval('mirtt_order_seq')::text;

  insert into orders (order_number, customer_name, phone, email, address, governorate, city,
                      notes, status, is_read, subtotal, shipping_fee, shipping_method, coupon_code,
                      discount_amount, total, utm_source, utm_medium, utm_campaign)
  values (v_number, btrim(p_customer_name), btrim(p_phone), nullif(btrim(coalesce(p_email, '')), ''),
          btrim(p_address), btrim(p_governorate), btrim(p_city),
          nullif(btrim(coalesce(p_notes, '')), ''), 'pending', false,
          v_subtotal, v_shipping, coalesce(p_shipping_method, 'standard'), nullif(btrim(coalesce(p_coupon_code, '')), ''),
          v_discount, v_total, p_utm_source, p_utm_medium, p_utm_campaign)
  returning id into v_order_id;

  for v_it in select * from jsonb_array_elements(v_items) loop
    v_vid := (v_it->>'variant_id')::uuid;
    insert into order_items (order_id, product_id, variant_id, product_name_snapshot,
                             color_name, size, quantity, unit_price, line_total)
    values (v_order_id, (v_it->>'product_id')::uuid, v_vid,
            v_it->>'name', v_it->>'color_name', v_it->>'size',
            (v_it->>'quantity')::int, (v_it->>'unit_price')::numeric,
            (v_it->>'line_total')::numeric);
    update product_variants pv set stock = pv.stock - (v_it->>'quantity')::int
      where pv.id = v_vid;
  end loop;

  return query select v_order_id, v_number, v_total;
end $$;

-- ---------------------------------------------------------------------------
-- 7) RPC: track_order(p_order_number, p_phone, p_client_ip)
--    Public order tracking — matches ONLY on order number + phone, so a
--    stranger can never enumerate orders. Returns one row or none.
--    v2: also returns the delivery destination fields (governorate / city /
--    customer name / address) so the storefront tracking map can draw the
--    real route. Drop-first keeps this file re-runnable over the v1 function.
-- ---------------------------------------------------------------------------
drop function if exists track_order(text, text, text);
create or replace function track_order(
  p_order_number text,
  p_phone        text,
  p_client_ip    text default null
)
returns table (order_number text, status text, created_at timestamptz, total numeric, items jsonb,
               governorate text, city text, customer_name text, address text)
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype;
begin
  if p_order_number is null or p_phone is null then return; end if;
  select * into v_order from orders o
    where o.order_number = btrim(p_order_number) and o.phone = btrim(p_phone)
    limit 1;
  if not found then return; end if;

  return query select
    v_order.order_number,
    v_order.status::text,
    v_order.created_at,
    v_order.total,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_name', oi.product_name_snapshot,
               'color',        oi.color_name,
               'size',         oi.size,
               'quantity',     oi.quantity) order by oi.created_at, oi.id)
      from order_items oi where oi.order_id = v_order.id
    ), '[]'::jsonb),
    v_order.governorate,
    v_order.city,
    v_order.customer_name,
    v_order.address;
end $$;

-- ---------------------------------------------------------------------------
-- 8) Row Level Security
--    The Manager always talks with the secret key (bypasses RLS). The public
--    site uses the publishable key — it may read the catalog/content and may
--    only INSERT reviews (unapproved), stock alerts and analytics rows.
-- ---------------------------------------------------------------------------
alter table profiles                    enable row level security;
alter table collections                 enable row level security;
alter table products                    enable row level security;
alter table product_variants            enable row level security;
alter table product_images              enable row level security;
alter table product_collections         enable row level security;
alter table orders                      enable row level security;
alter table order_items                 enable row level security;
alter table product_reviews             enable row level security;
alter table coupons                     enable row level security;
alter table pages_content               enable row level security;
alter table site_settings               enable row level security;
alter table campaign_banners            enable row level security;
alter table offers                      enable row level security;
alter table drops                       enable row level security;
alter table analytics_sessions          enable row level security;
alter table analytics_events            enable row level security;
alter table abandoned_carts             enable row level security;
alter table back_in_stock_subscriptions enable row level security;
alter table audit_log                   enable row level security;

-- public reads (catalog + content + approved reviews)
drop policy if exists "public read collections" on collections;
create policy "public read collections" on collections for select to anon, authenticated using (true);
drop policy if exists "public read products" on products;
create policy "public read products" on products for select to anon, authenticated using (true);
drop policy if exists "public read variants" on product_variants;
create policy "public read variants" on product_variants for select to anon, authenticated using (true);
drop policy if exists "public read images" on product_images;
create policy "public read images" on product_images for select to anon, authenticated using (true);
drop policy if exists "public read product links" on product_collections;
create policy "public read product links" on product_collections for select to anon, authenticated using (true);
drop policy if exists "public read pages" on pages_content;
create policy "public read pages" on pages_content for select to anon, authenticated using (true);
drop policy if exists "public read settings" on site_settings;
create policy "public read settings" on site_settings for select to anon, authenticated using (true);
drop policy if exists "public read banners" on campaign_banners;
create policy "public read banners" on campaign_banners for select to anon, authenticated using (true);
drop policy if exists "public read offers" on offers;
create policy "public read offers" on offers for select to anon, authenticated using (true);
drop policy if exists "public read drops" on drops;
create policy "public read drops" on drops for select to anon, authenticated using (true);
-- reviews: only approved ones are public — pending ones stay Manager-only
drop policy if exists "public read approved reviews" on product_reviews;
create policy "public read approved reviews" on product_reviews for select to anon, authenticated using (is_approved = true);

-- public inserts (customer-facing forms + telemetry)
drop policy if exists "public submit reviews" on product_reviews;
create policy "public submit reviews" on product_reviews for insert to anon, authenticated
  with check (is_approved = false);
drop policy if exists "public stock alerts" on back_in_stock_subscriptions;
create policy "public stock alerts" on back_in_stock_subscriptions for insert to anon, authenticated
  with check (true);
drop policy if exists "public analytics sessions" on analytics_sessions;
create policy "public analytics sessions" on analytics_sessions for insert to anon, authenticated
  with check (true);
drop policy if exists "public analytics events" on analytics_events;
create policy "public analytics events" on analytics_events for insert to anon, authenticated
  with check (true);

-- orders / order_items / coupons / profiles / abandoned_carts / audit_log:
-- no anon policies at all — the public surface goes through the SECURITY
-- DEFINER RPCs above and the Manager's secret key bypasses RLS anyway.

-- hard grants to match the policies (PostgREST needs both)
grant select on collections, products, product_variants, product_images,
  product_collections, pages_content, site_settings, campaign_banners,
  offers, drops, product_reviews to anon, authenticated;
grant insert on product_reviews, back_in_stock_subscriptions,
  analytics_sessions, analytics_events to anon, authenticated;
revoke all on orders, order_items, coupons, profiles, abandoned_carts, audit_log
  from anon, authenticated;

-- RPC execution rights
-- NOTE: p_shipping_method has a DEFAULT, which does NOT create a separate
-- 12-argument signature in Postgres. Only the 13-argument function below
-- exists, so only that one is revoked/granted here.
-- Task 113: the 13-argument signature (with p_shipping_method) needs its own
-- grants — Postgres treats it as a distinct function overload.
revoke execute on function create_mirtt_order(text,text,text,text,text,text,text,jsonb,text,text,text,text,text) from public, anon, authenticated;
grant execute on function create_mirtt_order(text,text,text,text,text,text,text,jsonb,text,text,text,text,text) to service_role;
grant execute on function validate_coupon(text, jsonb) to anon, authenticated, service_role;
grant execute on function track_order(text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9) Storage: public "product-images" bucket (Manager → Media cloud mode)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product images public read" on storage.objects;
create policy "product images public read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-images');

-- ============================================================================
-- 10) Control reference — every section the Manager controls lives in
--     pages_content / site_settings. This block documents the exact keys the
--     storefront reads today (Task 103-109). The tables above already accept
--     all of them (jsonb content, no key constraints) — nothing to migrate.
-- ============================================================================
--
-- pages_content (page_key, section_key, sort_order, content jsonb):
--
--   page_key = 'product'  → Website editor ▸ Product page (12 fixed sections)
--     gallery   content:{hidden}                          — product images column
--     info      content:{hidden}                          — name & price
--     colors    content:{hidden}                          — color swatches
--     sizes     content:{hidden}                          — size chips
--     buy       content:{hidden, add_label, buy_label}    — buy buttons text
--     description  content:{hidden, title}
--     shipping     content:{hidden, title, text}          — site-wide fallback text
--     returns      content:{hidden, title, text}          — site-wide fallback text
--     size_chart   content:{hidden, title}                — renders product.size_chart_url
--     reviews      content:{hidden, title, show_form}
--     related      content:{hidden, title, count}         — count = products in the row (1-12, default 4)
--     continue     content:{hidden, text}                 — continue-shopping link
--     (reordering = sort_order inside 3 zones: info column 2-5, accordions 6-9, below 10-12;
--      hidden=true hides the section from the live website)
--
--   page_key = 'home' | 'shop' | 'collections' | 'about' | 'contact' | 'privacy'
--             | 'terms' | 'footer' | 'collection:<slug>'  (per-collection page)
--     → Website editor ▸ page builder sections:
--     hero, heritage_section, collection_banner, featured_products,
--     featured_collections, product_order, shop_layout, collection_order,
--     story, contact, privacy, terms, custom, editorial_gallery
--     content carries each section's fields (titles, texts, image_url, cta_link,
--     product_ids / collection_ids arrays, layout variants, hidden, …)
--
-- site_settings (key → value jsonb):
--   shipping_fees    {cairo, giza, alexandria, other, express, free_over}
--     'express' (Task 113) = flat nationwide express price; the checkout shows
--     Express delivery as its own option and orders store it in
--     orders.shipping_method ('standard' | 'express'). free_over unlocks the
--     standard option only.
--   contact_info     {phone, email, address, …}
--   home_banner_style, menu_links, nav_links,
--   theme_colors, meta_pixel_id, tiktok_pixel_id
--
-- products columns driven by Manager ▸ Product discounts:
--   discount_active, sale_price (per-product sale pricing)
-- products.size_chart_url → the per-product size-chart image the owner uploads
--   (renders inside the product page's Size chart accordion)
-- products.image_url → the single cover image shown on Manager product cards.
-- products.size_type → 'letters' (S/M/L/XL) | 'numbers' (28–38); null ⇒ the
--   storefront derives it from the category (Task 195).
-- products.stock_total → headline "Available quantity" = Σ colour/size stock,
--   recomputed by the order writer as sales land (Task 195).
-- product_variants rows → THE per-size stock: one row per colour × size × stock,
--   written/read by the Manager product editor's colour grid (Task 195).
-- orders.payment_method → 'cod' (Task 194); orders.offer_discount / offer_titles
--   → the automatic bundle saving stamped on the order at checkout (Task 189).
-- offers / drops → Manager ▸ Website ▸ Offers and Manager ▸ Drops.
-- Customer order email (Task 194/196): the brand logo and the tracking QR are
--   attached inline (cid:) — no schema impact.
--
-- Storage bucket 'product-images' → Manager ▸ Media library (cloud mode)
-- After applying this file: Manager ▸ Settings ▸ "Move to cloud storage" ▸ Sync
-- pushes the locally-saved control rows (pages_content / site_settings / catalog /
-- reviews / back-in-stock) into these tables — nothing is lost from preview mode.
