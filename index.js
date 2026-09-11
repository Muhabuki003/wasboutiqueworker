/**
 * ═══════════════════════════════════════════════════════════════
 *  WAS Boutique  ×  Cloudflare Worker  ×  Square API
 * ═══════════════════════════════════════════════════════════════
 *
 *  Routes
 *  ──────────────────────────────────────────────────────────────
 *  GET  /health           → worker status check
 *  GET  /catalog          → full product catalog from Square
 *  GET  /catalog/images   → image URL map { squareId: url }
 *  POST /quote            → shipping + tax quote (NO Square call)
 *  POST /checkout         → create Square Payment Link → { checkoutUrl }
 *
 *  Environment variables (set in wrangler.toml or dashboard)
 *  ──────────────────────────────────────────────────────────────
 *  SQUARE_ACCESS_TOKEN   (secret — set via wrangler secret put)
 *  SQUARE_LOCATION_ID    Square location ID
 *  ALLOWED_ORIGIN        your site origin, e.g. https://wasboutique.com
 *  SITE_URL              redirect after checkout (same as ALLOWED_ORIGIN)
 *  CATALOG_CACHE_TTL     seconds to cache catalog (default 300)
 *
 *  Shipping / tax configuration (all optional, sane defaults in code)
 *  ──────────────────────────────────────────────────────────────
 *  SHIPPING_FLAT_CENTS        US flat shipping          (default 695)
 *  SHIPPING_FREE_OVER_CENTS   free US shipping at/above (default 7500; 0 = off)
 *  SHIPPING_INTL_FLAT_CENTS   non-US flat shipping      (default 1995)
 *  TAX_RATES                   JSON { "TX": 8.25 }      (default {} = no tax)
 *  TAX_SHIPPING                "true" to also tax shipping (default "false")
 *
 *  NOTE ON SQUARE: Square's automatic destination tax + shipping rate
 *  profiles are Square *Online* features and DO NOT apply to orders created
 *  through the API. Shipping must be passed as checkout_options.shipping_fee
 *  and tax as explicit order.taxes. We deliberately do NOT set
 *  pricing_options.auto_apply_taxes alongside explicit order.taxes
 *  (double-taxation risk).
 */

const SQUARE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-11-20';

/* ─────────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────────── */

function corsHeaders(env, requestOrigin) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = allowed === '*' ? '*' : requestOrigin || allowed;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...extraHeaders,
    },
  });
}

function err(message, status = 500, extraHeaders = {}, errors = []) {
  return json({ error: message, errors }, status, extraHeaders);
}

/**
 * Make an authenticated request to the Square API.
 * Throws { status, errors } on non-2xx.
 */
async function sq(env, path, options = {}) {
  const res = await fetch(SQUARE + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
      ...(options.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = body.errors?.[0]?.detail || res.statusText;
    throw { status: res.status, errors: body.errors || [], message: detail };
  }

  return body;
}

/* ─────────────────────────────────────────────────────────────
   SHIPPING / TAX CONFIG + QUOTE ENGINE
───────────────────────────────────────────────────────────── */

function intFromEnv(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function taxRatesFromEnv(env) {
  try {
    const parsed = JSON.parse(env.TAX_RATES || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const pct = Number(v);
      if (k && Number.isFinite(pct)) out[String(k).trim().toUpperCase()] = pct;
    }
    return out;
  } catch {
    return {};
  }
}

function shippingConfig(env) {
  return {
    flat:     intFromEnv(env.SHIPPING_FLAT_CENTS, 695),
    freeOver: intFromEnv(env.SHIPPING_FREE_OVER_CENTS, 7500),
    intlFlat: intFromEnv(env.SHIPPING_INTL_FLAT_CENTS, 1995),
    taxRates: taxRatesFromEnv(env),
    taxShipping: boolFromEnv(env.TAX_SHIPPING, false),
  };
}

function isUSAddress(addr) {
  const c = String(addr?.country || 'US').trim().toUpperCase();
  return c === 'US' || c === 'USA' || c === 'UNITED STATES' || c === 'UNITED STATES OF AMERICA';
}

/** Round a dollar price to integer cents, safely. */
function toCents(price) {
  const n = Number(price);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Compute shipping + tax for a cart and a destination address.
 * Pure function — no network calls. All internal maths is in cents.
 *
 * @returns {object} quote with dollars (2dp) + `_cents` integer fields
 */
function computeQuote(env, lineItems, shippingAddress) {
  const cfg = shippingConfig(env);
  const addr = shippingAddress || {};

  const subtotalCents = (lineItems || []).reduce(
    (sum, i) => sum + toCents(i.price) * (parseInt(i.quantity, 10) || 0),
    0
  );

  const us = isUSAddress(addr);
  const freeShippingApplied =
    us && cfg.freeOver > 0 && subtotalCents >= cfg.freeOver;

  let shippingFeeCents;
  if (us) {
    shippingFeeCents = freeShippingApplied ? 0 : cfg.flat;
  } else {
    shippingFeeCents = cfg.intlFlat;
  }

  // Destination tax — US state code lookup only. Unknown/empty state => 0.
  const state = String(addr.state || '').trim().toUpperCase();
  const taxRate = us && state && cfg.taxRates[state] !== undefined
    ? Number(cfg.taxRates[state])
    : 0;

  const taxableBaseCents = subtotalCents + (cfg.taxShipping ? shippingFeeCents : 0);
  const taxAmountCents = Math.round(taxableBaseCents * (taxRate / 100));
  const totalCents = subtotalCents + shippingFeeCents + taxAmountCents;

  const d = c => +(c / 100).toFixed(2);

  return {
    subtotal:            d(subtotalCents),
    shippingFee:         d(shippingFeeCents),
    taxRate:             +(taxRate).toFixed(4),
    taxAmount:           d(taxAmountCents),
    total:               d(totalCents),
    freeShippingApplied: freeShippingApplied,
    currency:            'USD',
    country:             us ? 'US' : (String(addr.country || '').toUpperCase() || 'US'),
    state:               state || null,
    shippingTaxed:       cfg.taxShipping,
    // integer-cent mirrors (convenient for the frontend / debugging)
    subtotalCents,
    shippingFeeCents,
    taxAmountCents,
    totalCents,
  };
}

/** Parse + validate line items shared by /quote and /checkout. */
function parseLineItems(body) {
  const lineItems = body?.lineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { error: 'lineItems must be a non-empty array' };
  }
  for (const item of lineItems) {
    if (!item.name || !item.price || !item.quantity) {
      return { error: 'Each line item requires: name, price (USD), quantity' };
    }
  }
  return { lineItems };
}

/* ─────────────────────────────────────────────────────────────
   CATALOG HANDLER
   GET /catalog
   Returns products shaped for the WAS Boutique frontend.
   Cached in the CF Cache API for CATALOG_CACHE_TTL seconds.
───────────────────────────────────────────────────────────── */

async function handleCatalog(request, env, cors, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(request.url + '?v=catalog', { method: 'GET' });
  const ttl = parseInt(env.CATALOG_CACHE_TTL || '300', 10);

  // Serve from cache if available
  const cached = await cache.match(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: { ...Object.fromEntries(cached.headers), ...cors, 'X-Cache': 'HIT' },
    });
  }

  // Fetch items + images in parallel
  const [itemsData, imagesData] = await Promise.all([
    sq(env, '/catalog/list?types=ITEM'),
    sq(env, '/catalog/list?types=IMAGE'),
  ]);

  const rawItems  = itemsData.objects  || [];
  const rawImages = imagesData.objects || [];

  // Build imageId → url lookup
  const imageMap = {};
  for (const img of rawImages) {
    if (img.image_data?.url) imageMap[img.id] = img.image_data.url;
  }

  // Map Square ITEM objects → product shape
  const products = rawItems
    .filter(o => o.type === 'ITEM' && !o.is_deleted)
    .map(o => {
      const d = o.item_data;
      const variations = d.variations?.filter(v => !v.is_deleted) || [];
      const firstVar = variations[0]?.item_variation_data;

      // Resolve images: item-level image_ids take priority
      const imageIds = d.image_ids || [];
      const imageUrls = imageIds.map(id => imageMap[id]).filter(Boolean);

      // Category
      const category =
        d.reporting_category?.name ||
        d.categories?.[0]?.name ||
        'Other';

      // Price (lowest variation price)
      const prices = variations
        .map(v => v.item_variation_data?.price_money?.amount)
        .filter(Boolean);
      const minPriceCents = prices.length ? Math.min(...prices) : 0;
      const price = +(minPriceCents / 100).toFixed(2);

      // Variations for selector
      const variantOptions = variations.map(v => ({
        id:    v.id,
        name:  v.item_variation_data?.name || 'Default',
        price: +(( v.item_variation_data?.price_money?.amount || minPriceCents) / 100).toFixed(2),
        sku:   v.item_variation_data?.sku || '',
      }));

      return {
        id:          o.id,
        name:        d.name,
        description: d.description || '',
        category,
        price,
        imageUrls,
        variants:    variantOptions,
        updatedAt:   o.updated_at,
      };
    });

  const payload = {
    products,
    count:      products.length,
    locationId: env.SQUARE_LOCATION_ID,
    fetchedAt:  new Date().toISOString(),
  };

  const response = json(payload, 200, {
    ...cors,
    'Cache-Control': `public, s-maxage=${ttl}`,
    'X-Cache': 'MISS',
  });

  // Store in CF cache
  const responseForCache = response.clone();
  ctx?.waitUntil?.(cache.put(cacheKey, responseForCache));

  return response;
}

/* ─────────────────────────────────────────────────────────────
   IMAGE MAP HANDLER
   GET /catalog/images
   Returns { squareImageId: url } — useful for enriching mock data
───────────────────────────────────────────────────────────── */

async function handleImages(request, env, cors) {
  const imagesData = await sq(env, '/catalog/list?types=IMAGE');
  const map = {};
  for (const img of (imagesData.objects || [])) {
    if (img.image_data?.url) map[img.id] = img.image_data.url;
  }
  return json({ images: map, count: Object.keys(map).length }, 200, cors);
}

/* ─────────────────────────────────────────────────────────────
   QUOTE HANDLER
   POST /quote
   Body: { lineItems: [{name, price, quantity}],
           shippingAddress: {line1, line2?, city, state, zip, country} }
   Returns the shipping + tax breakdown. NO Square API call is made.
───────────────────────────────────────────────────────────── */

async function handleQuote(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body', 400, cors);
  }

  const parsed = parseLineItems(body);
  if (parsed.error) return err(parsed.error, 400, cors);

  const quote = computeQuote(env, parsed.lineItems, body.shippingAddress);
  return json({ ...quote, quotedAt: new Date().toISOString() }, 200, cors);
}

/* ─────────────────────────────────────────────────────────────
   CHECKOUT HANDLER
   POST /checkout
   Body: { lineItems: [{ id, name, price, quantity, variantId? }],
           shippingAddress?: {...}, customerEmail?: string }
   Returns: { checkoutUrl, orderId, paymentLinkId, ...totals }

   When shippingAddress is supplied, the payment link carries the
   computed shipping fee + destination tax and the address is baked
   into the fulfillment (ask_for_shipping_address = false so a later
   override on Square's page can't invalidate the tax we computed).

   When shippingAddress is absent, behaviour is unchanged from the
   pre-shipping/tax version (ask_for_shipping_address: true, no fees)
   so an older frontend keeps working.
───────────────────────────────────────────────────────────── */

async function handleCheckout(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body', 400, cors);
  }

  const parsed = parseLineItems(body);
  if (parsed.error) return err(parsed.error, 400, cors);
  const { lineItems } = parsed;

  const shippingAddress = body.shippingAddress || null;
  const customerEmail =
    typeof body.customerEmail === 'string' && body.customerEmail.trim()
      ? body.customerEmail.trim()
      : null;

  const squareLineItems = lineItems.map(item => {
    const base = {
      name:     item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount:   toCents(item.price), // cents
        currency: 'USD',
      },
    };

    // If a real Square catalog variation ID is provided, use it
    // (Square catalog IDs start with a specific format — we detect
    // them by checking they don't look like our mock "p1","p2" IDs)
    if (item.variantId && /^[A-Z0-9]{20,}$/.test(item.variantId)) {
      return { ...base, catalog_object_id: item.variantId };
    }

    return base;
  });

  const redirectUrl =
    body.redirectUrl ||
    env.SITE_URL ||
    env.ALLOWED_ORIGIN ||
    'https://wasboutique.com';

  const order = {
    location_id: env.SQUARE_LOCATION_ID,
    line_items:  squareLineItems,
    metadata: {
      source: 'WAS Boutique website',
    },
  };

  const checkoutOptions = {
    redirect_url:               redirectUrl + '?order=success',
    ask_for_shipping_address:   true,
    merchant_support_email:     'amburnett55@yahoo.com',
    enable_coupon:              false,
    enable_loyalty:             false,
  };

  const payload = {
    idempotency_key: crypto.randomUUID(),
    order,
    checkout_options: checkoutOptions,
    payment_note: 'WAS Boutique',
  };

  let quote = null;

  if (shippingAddress) {
    quote = computeQuote(env, lineItems, shippingAddress);

    const addr = shippingAddress;
    const squareAddress = {
      first_name:                      addr.firstName || undefined,
      last_name:                       addr.lastName || undefined,
      address_line_1:                  addr.line1 || undefined,
      address_line_2:                  addr.line2 || undefined,
      locality:                        addr.city || undefined,
      administrative_district_level_1: String(addr.state || '').toUpperCase() || undefined,
      postal_code:                     addr.zip || undefined,
      country:                         String(addr.country || 'US').toUpperCase(),
    };

    // (a) shipping fee — applied to the order as a service charge.
    //     Square's ShippingFee object wraps the money in `charge`.
    if (quote.shippingFeeCents > 0) {
      checkoutOptions.shipping_fee = {
        uid:    'was-shipping-fee',
        name:   'Shipping',
        charge: {
          amount:   quote.shippingFeeCents,
          currency: 'USD',
        },
      };
    }

    // (d) Square REQUIRES ask_for_shipping_address = true whenever a
    //     shipping_fee is present ("AskForShippingAddress cannot be set to
    //     'false' if ShippingFee is present"). We therefore keep it true and
    //     pre-populate the buyer address instead, so the customer sees the
    //     address we priced and normally never edits it. The same address is
    //     also baked into the fulfillment below.
    checkoutOptions.ask_for_shipping_address = true;

    // (b) explicit order-scoped tax — only when we're actually collecting.
    //     Never combined with pricing_options.auto_apply_taxes.
    if (quote.taxAmountCents > 0) {
      order.taxes = [{
        uid:        'was-' + (crypto.randomUUID?.() || String(Date.now())),
        name:       'Sales Tax',
        percentage: String(quote.taxRate),
        scope:      'ORDER',
      }];
    }

    // (c) Ship-to on the order.
    //     Square rejects `order.fulfillments` supplied together with
    //     `pre_populated_data` ("Only one of [fulfillment, buyer_address]
    //     fields should be set"). Because a shipping fee REQUIRES
    //     ask_for_shipping_address = true, Square itself creates the
    //     SHIPMENT fulfillment on the order from the confirmed address, and
    //     we pre-populate that address below so the customer simply confirms
    //     the address we priced. This is Square's documented "Prepopulate the
    //     shipping address" configuration.
    // pre-populate Square's checkout form with the address we priced
    payload.pre_populated_data = { buyer_address: squareAddress };
  }

  if (customerEmail) {
    payload.pre_populated_data = {
      ...(payload.pre_populated_data || {}),
      buyer_email: customerEmail,
    };
  }

  const result = await sq(env, '/online-checkout/payment-links', {
    method: 'POST',
    body:   JSON.stringify(payload),
  });

  const link = result.payment_link;

  return json({
    checkoutUrl:   link?.url,
    orderId:       link?.order_id,
    paymentLinkId: link?.id,
    createdAt:     link?.created_at,
    // echo of the computed totals (null when no address was supplied)
    subtotal:            quote ? quote.subtotal : null,
    shippingFee:         quote ? quote.shippingFee : null,
    taxRate:             quote ? quote.taxRate : null,
    taxAmount:           quote ? quote.taxAmount : null,
    total:               quote ? quote.total : null,
    freeShippingApplied: quote ? quote.freeShippingApplied : null,
    currency:            'USD',
  }, 200, cors);
}

/* ─────────────────────────────────────────────────────────────
   MAIN ENTRY POINT
───────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(env, origin);

    // ── CORS preflight ──────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Guard: require SQUARE_ACCESS_TOKEN ──────────────────
    if (!env.SQUARE_ACCESS_TOKEN) {
      return err(
        'SQUARE_ACCESS_TOKEN secret is not configured. ' +
        'Run: wrangler secret put SQUARE_ACCESS_TOKEN',
        503, cors
      );
    }

    try {
      // ── Route table ─────────────────────────────────────────
      const { pathname } = url;
      const method = request.method.toUpperCase();

      if (pathname === '/health' && method === 'GET') {
        return json({
          status:     'ok',
          worker:     'WAS Boutique × Square',
          locationId: env.SQUARE_LOCATION_ID || '(not set)',
          timestamp:  new Date().toISOString(),
        }, 200, cors);
      }

      if (pathname === '/catalog' && method === 'GET') {
        return await handleCatalog(request, env, cors, ctx);
      }

      if (pathname === '/catalog/images' && method === 'GET') {
        return await handleImages(request, env, cors);
      }

      if (pathname === '/quote' && method === 'POST') {
        return await handleQuote(request, env, cors);
      }

      if (pathname === '/checkout' && method === 'POST') {
        return await handleCheckout(request, env, cors);
      }

      return err('Route not found', 404, cors);

    } catch (e) {
      console.error('[Worker error]', e);

      // Square API error (thrown from sq())
      if (e.errors) {
        return json(
          { error: e.message || 'Square API error', errors: e.errors },
          e.status || 502,
          cors
        );
      }

      return err('Unexpected worker error: ' + (e.message || String(e)), 500, cors);
    }
  },
};
