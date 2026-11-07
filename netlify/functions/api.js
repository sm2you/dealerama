/**
 * Dealerama API — Netlify Function (Functions 2.0 / ESM)
 *
 * One endpoint that speaks to the Google Apps Script backend and normalises
 * everything the storefront and admin panel consume.
 *
 *   GET  /api                 -> public data  { settings, products, reviews }
 *   GET  /api?action=health   -> deployment diagnostics (no secret needed)
 *   POST /api  {action, ...}  -> anything (adminGet, saveAll, checkout, ...)
 *
 * Fixes baked in:
 *  - GET is supported instead of replying 405 "Method Not Allowed".
 *  - Every response is JSON, even on failure, so `.json()` never explodes.
 *  - If Apps Script answers a POST with 405 / HTML / no JSON, the request is
 *    retried as a GET with an `action` + `payload` query string (Apps Script
 *    web apps behave differently depending on deployment settings).
 *  - Products are normalised here (ids, images, variants) so the browser never
 *    has to guess about `'` characters, nested arrays or JSON-in-a-cell.
 *
 * ROUTING (learned the hard way, in production):
 *  - Do NOT declare `config.path` here. A custom path replaces the default
 *    `/.netlify/functions/api` route, and `path: '/api/*'` does not match the
 *    bare `/api` the storefront calls — the result is a 404 on every request.
 *  - Instead, netlify.toml rewrites `/api` and `/api/*` to the default function
 *    route, so both spellings work and the function keeps its own URL.
 */

const APPS_SCRIPT_URL = () => (process.env.APPS_SCRIPT_URL || '').trim();
const MAX_GET_FALLBACK = 6000; // Google's URL length ceiling is ~8 KB

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra }
  });

const str = (v) => (v == null ? '' : String(v));

function num(v, fallback = 0) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const n = parseFloat(str(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : fallback;
}

const bool = (v) => v === true || String(v).toLowerCase() === 'true';

/* ------------------------------------------------------------------ *
 * Normalisers
 * ------------------------------------------------------------------ */

/** Turn imagesJson / images / "['url']" / nested arrays into a clean URL list. */
function toUrlList(val) {
  let parsed = val;
  if (typeof parsed === 'string') {
    const t = parsed.trim();
    if (!t) return [];
    try {
      parsed = JSON.parse(t);
    } catch {
      parsed = t.split(/[\n,]+/);
    }
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  const out = [];
  for (const item of parsed.flat(Infinity)) {
    if (item == null) continue;
    // strip stray JSON punctuation / quotes that leak out of Sheets cells
    const url = str(item).replace(/[\[\]"'\\]/g, '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const clean = url.replace(/([?&])(w|width|h|height|q|quality|fit|resize|size)=[^&]*/gi, '$1').replace(/[?&]+$/, '');
    if (!out.includes(clean)) out.push(clean);
  }
  return out;
}

/** variantsJson (string or object) -> { options:[{name,values}], items:[{key,price,qty,image,sold}] } */
function toVariants(val) {
  let v = val;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || t === 'null' || t === 'undefined' || t === '{}') return null;
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const rawItems = Array.isArray(v.items) ? v.items : [];
  const items = rawItems
    .map((it) => {
      // Legacy rows stored keys as "Red / M" (Shopify public_title) or "Red | M".
      // The admin grid and product page both compare against "Red|M".
      let key = str(it.key).trim().replace(/\s*\|\s*/g, '|');
      if (!key.includes('|') && /\s\/\s/.test(key)) key = key.split(/\s*\/\s*/).join('|');
      if (!key) return null;
      const price = it.price === '' || it.price == null ? null : num(it.price, 0);
      const img = it.image ? toUrlList([it.image])[0] || null : null;
      return {
        key,
        price: price && price > 0 ? price : null,
        qty: Math.max(0, Math.round(num(it.qty, 0))),
        sold: Math.max(0, Math.round(num(it.sold, 0))),
        image: img
      };
    })
    .filter(Boolean)
    .slice(0, 200);
  if (!items.length) return null;

  let options = Array.isArray(v.options) ? v.options : [];
  options = options
    .map((o) => ({
      name: str(o && o.name).trim(),
      values: (Array.isArray(o && o.values) ? o.values : []).map(str).filter(Boolean).slice(0, 60)
    }))
    .filter((o) => o.name && o.values.length)
    .slice(0, 3);

  // Rebuild options from the item keys if the scraper only produced keys.
  if (!options.length) {
    const width = items[0].key.split('|').length;
    options = Array.from({ length: width }, (_, i) => ({
      name: width === 1 ? 'Option' : `Option ${i + 1}`,
      values: []
    }));
    items.forEach((it) => {
      it.key.split('|').forEach((part, i) => {
        if (options[i] && !options[i].values.includes(part)) options[i].values.push(part);
      });
    });
    options = options.filter((o) => o.values.length);
  }
  return { options, items };
}

function normaliseProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const id = str(p.id).replace(/['"\s]/g, '');
  const title = str(p.title).trim();
  if (!id || !title) return null;

  const variants = toVariants(p.variants != null ? p.variants : p.variantsJson);
  const images = toUrlList(
    Array.isArray(p.images) && p.images.length ? p.images : p.imagesJson || p.images
  );

  let qty = Math.max(0, Math.round(num(p.qty, 0)));
  let sold = Math.max(0, Math.round(num(p.sold, 0)));
  if (variants) {
    qty = variants.items.reduce((a, i) => a + i.qty, 0);
    sold = variants.items.reduce((a, i) => a + i.sold, 0);
  }

  const basePrice = num(p.basePrice != null ? p.basePrice : p.price, 0);
  let price = num(p.price, basePrice);
  let priceFrom = bool(p.priceFrom);
  if (variants) {
    const prices = variants.items.map((i) => i.price).filter((n) => n > 0);
    if (prices.length) {
      price = Math.min(...prices);
      priceFrom = priceFrom || new Set(prices.map((n) => n.toFixed(2))).size > 1;
    }
  }

  return {
    id,
    title,
    description: str(p.description),
    price,
    basePrice: basePrice || price,
    priceFrom,
    qty,
    sold,
    status: str(p.status || 'draft').toLowerCase(),
    dealType: str(p.dealType || 'daily').toLowerCase(),
    startsAt: str(p.startsAt).slice(0, 10),
    preorder: bool(p.preorder),
    videoUrl: str(p.videoUrl),
    stripeLink: str(p.stripeLink),
    images,
    variants,
    rating: num(p.rating, 0),
    reviewCount: Math.round(num(p.reviewCount, 0))
  };
}

function normaliseReview(r) {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id).trim();
  if (!id) return null;
  return {
    id,
    productId: str(r.productId).trim(),
    stars: Math.max(0, Math.min(5, Math.round(num(r.stars, 0)))),
    name: str(r.name),
    email: str(r.email),
    text: str(r.text),
    status: str(r.status || 'shown').toLowerCase(),
    reply: str(r.reply),
    verified: bool(r.verified),
    createdAt: str(r.createdAt)
  };
}

function normaliseOrder(o) {
  if (!o || typeof o !== 'object') return null;
  const id = str(o.id).trim();
  if (!id) return null;
  return {
    ...o,
    id,
    qty: Math.max(1, Math.round(num(o.qty, 1))),
    amount: num(o.amount, 0),
    shipStatus: str(o.shipStatus),
    tracking: str(o.tracking)
  };
}

/** Public settings only — never leak the write-only keys. */
function normaliseSettings(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (/secret|api_key|password|private/i.test(k)) continue;
    out[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

function normalisePayload(data, isPublic) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'The backend returned an unexpected response.' };
  }
  const out = { ...data };
  if (Array.isArray(out.products)) {
    out.products = out.products.map(normaliseProduct).filter(Boolean);
  }
  if (Array.isArray(out.reviews)) {
    out.reviews = out.reviews.map(normaliseReview).filter(Boolean);
  }
  if (Array.isArray(out.orders)) {
    out.orders = out.orders.map(normaliseOrder).filter(Boolean);
  }
  if (out.settings && typeof out.settings === 'object') {
    out.settings = isPublic ? normaliseSettings(out.settings) : out.settings;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Apps Script transport
 * ------------------------------------------------------------------ */

function tryParse(text) {
  const t = str(text).trim();
  if (!t) return undefined;
  // Apps Script sometimes prefixes JSON with a warning/HTML wrapper.
  const first = t.search(/[[{]/);
  if (first > 0 && !t.startsWith('<')) {
    try {
      return JSON.parse(t.slice(first));
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function looksLikeHtml(text) {
  return /^\s*(<!doctype|<html|<\?xml|<meta|<script)/i.test(str(text));
}

function describeBadResponse(text, status) {
  const snippet = str(text).replace(/\s+/g, ' ').slice(0, 160);
  if (looksLikeHtml(text)) {
    return (
      'Google Apps Script returned an HTML page instead of JSON. ' +
      'Redeploy it as a Web App: Execute as "Me", Who has access "Anyone", then use the /exec URL in APPS_SCRIPT_URL. ' +
      (status ? `(HTTP ${status})` : '')
    );
  }
  if (/method not allowed/i.test(text)) {
    return 'Google Apps Script rejected the HTTP method. Re-deploy the Web App so that it exposes doGet and doPost.';
  }
  return `Google Apps Script did not return JSON (HTTP ${status}). ${snippet}`;
}

async function appsScript(payload) {
  const base = APPS_SCRIPT_URL();
  if (!base) {
    return {
      data: {
        error:
          'APPS_SCRIPT_URL is not set. Add it in Netlify → Site configuration → Environment variables and redeploy.'
      }
    };
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(base)) {
    return {
      data: {
        error:
          'APPS_SCRIPT_URL looks wrong. It must be the /exec Web App URL ' +
          '(https://script.google.com/macros/s/…/exec), not the /edit editor URL.'
      }
    };
  }

  const action = str(payload.action || 'getPublic');

  // 1) Normal POST (works for correctly deployed Apps Script web apps).
  let postFailure = '';
  let postStatus = 0;
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    postStatus = r.status;
    const text = await r.text();
    const parsed = tryParse(text);
    if (parsed !== undefined) return { data: parsed, via: 'POST' };
    postFailure = text;
  } catch (err) {
    postFailure = `Network error talking to Apps Script: ${err.message}`;
  }

  // 2) GET fallback: action + payload travel in the query string.
  const body = JSON.stringify(payload);
  if (body.length <= MAX_GET_FALLBACK) {
    try {
      const u = new URL(base);
      u.searchParams.set('action', action);
      u.searchParams.set('payload', body);
      const r = await fetch(u.toString(), { method: 'GET', redirect: 'follow' });
      const text = await r.text();
      const parsed = tryParse(text);
      if (parsed !== undefined) return { data: parsed, via: 'GET' };
      if (!postFailure) postFailure = text;
    } catch (err) {
      if (!postFailure) postFailure = `Network error talking to Apps Script: ${err.message}`;
    }
  }

  const hint =
    action === 'addProductAuto'
      ? ' If this keeps failing, the request may be too large for the GET fallback — check the Apps Script deployment access level.'
      : '';
  return {
    error: describeBadResponse(postFailure, postStatus) + hint,
    status: 502
  };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return json({ error: 'Bad request URL.' }, 400);
  }

  // Cheap diagnostics endpoint — no secret, no Apps Script call.
  if (url.searchParams.get('action') === 'health' || url.pathname.endsWith('/health')) {
    const base = APPS_SCRIPT_URL();
    return json({
      ok: true,
      function: 'dealerama-api',
      appsScriptConfigured: Boolean(base),
      appsScriptLooksValid: /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(base),
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      time: new Date().toISOString()
    });
  }

  let payload = {};
  let isPublic = false;

  if (req.method === 'GET' || req.method === 'HEAD') {
    const action = url.searchParams.get('action') || 'getPublic';
    // A GET can never carry a body, and query strings leak into logs/browser
    // history — so writes and admin reads must use POST.
    if (!['getPublic', 'get', 'public', 'health'].includes(action)) {
      return json(
        { error: `"${action}" must be sent with POST, not GET.` },
        400
      );
    }
    isPublic = true;
    payload = { action };
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== 'payload' && k !== 'action') payload[k] = v;
    }
  } else if (req.method === 'POST') {
    const raw = await req.text();
    if (!raw || !raw.trim()) {
      return json({ error: 'Empty request body. Send JSON like {"action":"getPublic"}.' }, 400);
    }
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'Request body must be a JSON object.' }, 400);
    }
    if (!payload.action) {
      // A POST with no action is a public read; keep it working.
      payload.action = 'getPublic';
      isPublic = true;
    } else {
      isPublic = ['getPublic', 'submitReview', 'myOrders', 'health'].includes(payload.action);
    }
  } else {
    return json({ error: `Method ${req.method} not allowed. Use GET or POST.` }, 405, {
      Allow: 'GET, POST, OPTIONS'
    });
  }

  const result = await appsScript(payload);

  if (result.error) {
    return json({ error: result.error, action: payload.action }, result.status || 502);
  }

  const data = normalisePayload(result.data, isPublic);
  if (data.error) {
    return json({ error: str(data.error) || 'Unknown backend error.', action: payload.action }, 200);
  }

  // Cache public reads briefly so the storefront is instant. Only the catalog
  // actions are cacheable — never admin data, orders or review responses, and
  // never anything that arrived with a secret or a customer token.
  const readOnly = ['getPublic', 'get', 'public'].includes(payload.action);
  const cacheable = readOnly && !payload.secret && !payload.token;
  const headers = cacheable
    ? { 'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=600' }
    : { 'Cache-Control': 'no-store' };

  return json({ ...data, via: result.via || 'POST' }, 200, headers);
}
