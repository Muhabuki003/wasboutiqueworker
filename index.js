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
 *  POST /checkout         → create Square Payment Link → { checkoutUrl }
 *
 *  Environment variables (set in wrangler.toml or dashboard)
 *  ──────────────────────────────────────────────────────────────
 *  SQUARE_ACCESS_TOKEN   (secret — set via wrangler secret put)
 *  SQUARE_LOCATION_ID    Square location ID
 *  ALLOWED_ORIGIN        your site origin, e.g. https://wasboutique.com
 *  SITE_URL              redirect after checkout (same as ALLOWED_ORIGIN)
 *  CATALOG_CACHE_TTL     seconds to cache catalog (default 300)
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
   CHECKOUT HANDLER
   POST /checkout
   Body: { lineItems: [{ id, name, price, quantity, variantId? }] }
   Returns: { checkoutUrl, orderId, paymentLinkId }
───────────────────────────────────────────────────────────── */

async function handleCheckout(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body', 400, cors);
  }

  const { lineItems } = body;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return err('lineItems must be a non-empty array', 400, cors);
  }

  // Validate each line item has minimum required fields
  for (const item of lineItems) {
    if (!item.name || !item.price || !item.quantity) {
      return err(
        'Each line item requires: name, price (USD), quantity',
        400, cors
      );
    }
  }

  const squareLineItems = lineItems.map(item => {
    const base = {
      name:     item.name,
      quantity: String(item.quantity),
      base_price_money: {
        amount:   Math.round(item.price * 100), // cents
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

  const payload = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      line_items:  squareLineItems,
      metadata: {
        source: 'WAS Boutique website',
      },
    },
    checkout_options: {
      redirect_url:               redirectUrl + '?order=success',
      ask_for_shipping_address:   true,
      merchant_support_email:     'amburnett55@yahoo.com',
      enable_coupon:              false,
      enable_loyalty:             false,
    },
    payment_note: 'WAS Boutique',
  };

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
