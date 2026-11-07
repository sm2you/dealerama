/**
 * Dealerama — Google Apps Script backend (Code.gs)   v5.0.0
 * ---------------------------------------------------------------------------
 * Bound to the Google Sheet. Called by the Netlify function (api.js) and,
 * for image-heavy imports, directly by the Chrome extension.
 *
 * SETUP (once):
 *   1. Extensions -> Apps Script, paste this file, Save.
 *   2. Run setup()  -> creates Sheet1 / Reviews / Orders / Settings + defaults
 *                      and prints your admin secret in the execution log.
 *   3. Deploy -> New deployment -> Web app
 *        Execute as: Me        Who has access: Anyone
 *      Copy the /exec URL into Netlify as APPS_SCRIPT_URL.
 *   4. Optional: run installTrigger() so paid Stripe orders apply every 5 min.
 *
 * FIXES IN THIS VERSION
 *   • doGet(e) understands ?action= and ?payload= (Netlify GET fallback).
 *   • doPost accepts getPublic/get (the storefront read) and a health probe.
 *   • Admin auth can no longer pass with an unset SECRET_KEY (timing-safe).
 *   • images_() survives apostrophes, quotes, nested arrays and broken JSON.
 *   • vparse_() normalises legacy variant keys ("Red / M" -> "Red|M").
 *   • saveProductAuto keeps the source URL when ImgBB fails, defaults stock
 *     to 1 and creates products as drafts.
 *   • saveAll_ writes whole rows (fast) and never skips deletions.
 *   • syncPayments is batched, capped and time-boxed for Netlify.
 *   • New confirmOrder action makes Stripe checkout instant (no 5-min wait).
 *   • getPublic_ is cached for 20s and invalidated on every write.
 *
 * COLUMN ORDER IS UNCHANGED from v4 — existing sheets keep working.
 */

const VERSION = '5.1.0';
const P = 'Sheet1';
const PH = ['id', 'title', 'price', 'description', 'imagesJson', 'dealType', 'stripeLink', 'createdAt', 'qty', 'sold', 'status', 'preorder', 'startsAt', 'videoUrl', 'variantsJson'];
const RH = ['id', 'productId', 'stars', 'text', 'name', 'orderRef', 'status', 'reply', 'createdAt', 'email'];
const OH = ['id', 'productId', 'qty', 'amount', 'stripeSessionId', 'status', 'email', 'createdAt', 'name', 'address', 'phone', 'payment', 'userEmail', 'shipStatus', 'tracking', 'variant'];

const DEFAULTS = {
  site_name: 'Dealerama', logo_url: '', primary_color: '#000000', accent_color: '#10b981',
  font_body: 'Inter', font_heading: 'Inter', heading_weight: '700', heading_style: 'normal', heading_transform: 'none', font_scale: '1',
  banner_on: 'false', banner_text: '', banner_color: '#ef4444',
  reviews_on: 'true', stock_bar_on: 'true', stock_bar_color: '#10b981', stock_low_at: '5',
  site_url: 'https://dealerama.netlify.app', google_client_id: '',
  footer_on: 'true', business_name: 'Dealerama', contact_email: '', ship_days: '3-7', return_days: '30',
  footer_text: '', footer_pages: '', review_mode: 'moderate',
  hero_on: 'false', hero_title: '', hero_sub: '', hero_image_url: '', text_color: '#1f2937', bg_color: '#f9f9f9', nav_bg: '#ffffff', footer_bg: '#ffffff', price_color: '#16a34a',
  card_radius: '12', button_radius: '999', grid_cols: '3', title_live: "Today's Hottest Deals", title_upcoming: 'Upcoming Deals', title_past: 'Past Deals',
  buy_label: 'Buy now', preorder_label: 'Pre-order', view_label: 'View Deal', badge_daily: 'Deal of the day', badge_weekly: 'Deal of the week'
};
const PRODUCT_FIELDS = ['title', 'price', 'description', 'dealType', 'qty', 'sold', 'status', 'preorder', 'startsAt', 'stripeLink', 'videoUrl'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CACHE_KEY = 'public_v3';
const CACHE_TTL = 360; // seconds; warmCache() refreshes it every 5 minutes
/** Status applied to products imported by the extension. Change to 'live' to publish instantly. */
const IMPORT_STATUS = 'draft';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const prop_ = (k) => PropertiesService.getScriptProperties().getProperty(k);
const sh_ = (n) => SpreadsheetApp.getActiveSpreadsheet().getSheetByName(n);
const num_ = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const out_ = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const safe_ = (s) => { s = String(s == null ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; };
const iso_ = (v) => (v instanceof Date ? v.toISOString() : String(v == null ? '' : v));
const bool_ = (v) => v === true || String(v).toLowerCase() === 'true';
const isUrl_ = (u) => /^https?:\/\/[^\s]+$/i.test(String(u == null ? '' : u).trim());
const cleanV_ = (x) => String(x == null ? '' : x).trim().replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 40);
const errMsg_ = (e) => String((e && e.message) || e);

/** Timing-safe string compare (admin secret). */
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */
/** RUN ONCE (safe to re-run): creates tabs/headers/defaults and an admin secret. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [[P, PH], ['Reviews', RH], ['Orders', OH], ['Settings', ['key', 'value']]].forEach((pair) => {
    const name = pair[0], headers = pair[1];
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    const lastCol = sheet.getLastColumn();
    const existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((x) => String(x).trim()).filter(String) : [];
    if (!existing.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      // Never reorder or overwrite existing headers: only append what is missing.
      const missing = headers.filter((h) => existing.indexOf(h) < 0);
      if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).setFontWeight('bold');
  });

  const st = sh_('Settings');
  const have = st.getLastRow() > 1 ? st.getRange(2, 1, st.getLastRow() - 1, 1).getValues().map((r) => String(r[0]).trim()) : [];
  const add = Object.keys(DEFAULTS).filter((k) => have.indexOf(k) < 0).map((k) => [k, DEFAULTS[k]]);
  if (add.length) st.getRange(st.getLastRow() + 1, 1, add.length, 2).setValues(add);

  const ps = PropertiesService.getScriptProperties();
  let created = '';
  if (!ps.getProperty('SECRET_KEY')) {
    created = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    ps.setProperty('SECRET_KEY', created);
  }
  SpreadsheetApp.flush();
  invalidate_();

  const lines = [
    'Dealerama backend ' + VERSION + ' — setup complete.',
    'Products tab: ' + P + ' | Reviews | Orders | Settings',
    created
      ? 'ADMIN SECRET (save it now, it is not shown again in the sheet): ' + created
      : 'Admin secret already existed (properties). Run newAdminSecret() to rotate it.',
    'Next: Deploy -> New deployment -> Web app (Execute as Me, Access Anyone),',
    'then paste the /exec URL into Netlify as APPS_SCRIPT_URL.',
    'Optional: run installTrigger() and set STRIPE_SECRET_KEY + IMGBB_API_KEY in Admin -> Settings.'
  ];
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Rotates the admin secret and logs the new one. */
function newAdminSecret() {
  const s = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  PropertiesService.getScriptProperties().setProperty('SECRET_KEY', s);
  Logger.log('New admin secret: ' + s);
  return s;
}

/** Applies paid Stripe orders every 5 minutes and keeps the public cache warm. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncPayments').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(5).create();
  Logger.log('Triggers installed: syncPayments + warmCache every 5 minutes.');
}

/**
 * Re-populates the public cache so a storefront request rarely pays for a cold
 * Apps Script start (that is what made the first page load take ~2.8s).
 */
function warmCache() {
  invalidate_();
  const payload = getPublic_();
  Logger.log('warmCache: ' + (payload.products || []).length + ' products cached for ' + CACHE_TTL + 's');
  return true;
}

/** Logs a health report — useful when something "just doesn't save". */
function selfTest() {
  const report = {
    version: VERSION,
    sheets: {},
    properties: {
      SECRET_KEY: !!prop_('SECRET_KEY'),
      STRIPE_SECRET_KEY: !!prop_('STRIPE_SECRET_KEY'),
      IMGBB_API_KEY: !!prop_('IMGBB_API_KEY')
    },
    triggers: ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction()),
    settingsCount: Object.keys(settings_(false)).length
  };
  [P, 'Reviews', 'Orders', 'Settings'].forEach((n) => {
    const s = sh_(n);
    report.sheets[n] = s ? { rows: Math.max(0, s.getLastRow() - 1), cols: s.getLastColumn() } : 'MISSING — run setup()';
  });
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ------------------------------------------------------------------ *
 * Sheet access
 * ------------------------------------------------------------------ */
function table_(n) {
  const sheet = sh_(n);
  if (!sheet) throw new Error('Missing tab "' + n + '". Run setup() in Apps Script.');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((x) => String(x).trim());
  const rows = values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach((k, j) => { o[k] = r[j]; });
    return o;
  }).filter((o) => o.id || o.key);
  return { s: sheet, h: headers, rows };
}

/** Writes a whole row in ONE API call (single-cell writes are what made Save slow). */
function updateRow_(t, row, patch) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return;
  const range = t.s.getRange(row, 1, 1, t.h.length);
  const values = range.getValues()[0];
  let changed = false;
  keys.forEach((k) => {
    const c = t.h.indexOf(k);
    if (c >= 0) { values[c] = patch[k] == null ? '' : patch[k]; changed = true; }
  });
  if (changed) range.setValues([values]);
}

/** Kept for backwards compatibility with older snippets. */
function setCell_(t, row, key, val) {
  const c = t.h.indexOf(key);
  if (c >= 0) t.s.getRange(row, c + 1).setValue(val);
}

/* ------------------------------------------------------------------ *
 * Settings / parsing
 * ------------------------------------------------------------------ */
function settings_(publicOnly) {
  const o = Object.assign({}, DEFAULTS);
  try {
    table_('Settings').rows.forEach((r) => { if (r.key) o[String(r.key)] = String(r.value); });
  } catch (e) { /* Settings tab missing before setup() */ }
  // Every setting is safe to publish; secrets live in Script Properties only.
  return o;
}

/** URLs out of imagesJson / images, surviving apostrophes, quotes, nesting and broken JSON. */
function images_(o) {
  if (!o) return [];
  let raw = (o.imagesJson != null && String(o.imagesJson).trim() !== '') ? o.imagesJson : o.images;
  if (Array.isArray(raw)) raw = raw;
  else {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return [];
    s = s.replace(/^['"`]+/, '').replace(/['"`]+$/, ''); // "rogue apostrophe" from Sheets
    try { raw = JSON.parse(s); } catch (e) { raw = s.split(/[\n,]+/); }
  }
  const flat = [];
  (function walk(x, depth) {
    if (depth > 4 || x == null) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (typeof x === 'object') { walk(x.url || x.src || '', depth + 1); return; }
    flat.push(String(x));
  })(raw, 0);

  const out = [];
  flat.forEach((u) => {
    const t = u.replace(/^['"\[]+|['"\]]+$/g, '').trim();
    if (isUrl_(t) && out.indexOf(t) < 0) out.push(t);
  });
  if (!out.length) {
    // Last resort: pull every URL out of the raw cell.
    const m = String(o.imagesJson || o.images || '').match(/https?:\/\/[^\s"',\]\\]+/g) || [];
    m.forEach((u) => { if (isUrl_(u) && out.indexOf(u) < 0) out.push(u); });
  }
  return out;
}

/** Normalises a variant key so "Red / M", "Red | M" and "Red|M" all compare equal. */
function fixKey_(k, optCount) {
  let s = String(k == null ? '' : k).trim();
  if (!s) return '';
  if (optCount > 1 && s.indexOf('|') < 0) {
    if (s.indexOf(' / ') >= 0) s = s.split(' / ').join('|');
    else if (s.indexOf(' | ') >= 0) s = s.split(' | ').join('|');
  }
  return s.split('|').map((x) => x.trim()).join('|');
}

function vparse_(o) {
  if (!o) return null;
  let raw = o.variantsJson != null && String(o.variantsJson).trim() !== '' ? o.variantsJson : o.variants;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw.replace(/^['"`]+/, '').trim()); } catch (e) { return null; }
  }
  if (!raw || !Array.isArray(raw.options) || !Array.isArray(raw.items) || !raw.items.length) return null;

  const optCount = raw.options.length;
  const options = raw.options.slice(0, 3).map((op) => ({
    name: String((op && op.name) || '').trim().slice(0, 30),
    values: (Array.isArray(op && op.values) ? op.values : []).map(cleanV_).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 40)
  })).filter((op) => op.name && op.values.length);
  if (!options.length) return null;

  const items = raw.items.map((it) => ({
    key: fixKey_(it && it.key, optCount),
    price: num_(it && it.price),
    qty: Math.max(0, Math.floor(num_(it && it.qty))),
    sold: Math.max(0, Math.floor(num_(it && it.sold))),
    image: isUrl_(it && it.image) ? String(it.image).trim() : ''
  })).filter((it) => it.key);
  return items.length ? { options: options, items: items } : null;
}

/** One product as the storefront/admin expects it. */
function view_(o) {
  const vj = vparse_(o);
  const images = images_(o);
  const p = {
    id: pid_(o),
    title: String(o.title == null ? '' : o.title),
    price: num_(o.price),
    basePrice: num_(o.price),
    description: String(o.description == null ? '' : o.description),
    images: images,
    dealType: String(o.dealType || 'daily'),
    qty: Math.max(0, num_(o.qty)),
    sold: num_(o.sold),
    status: String(o.status || 'draft'),
    preorder: bool_(o.preorder),
    startsAt: iso_(o.startsAt),
    videoUrl: String(o.videoUrl || ''),
    stripeLink: String(o.stripeLink || ''),
    variants: vj,
    priceFrom: false
  };
  if (vj) {
    p.qty = vj.items.reduce((a, i) => a + num_(i.qty), 0);
    p.sold = vj.items.reduce((a, i) => a + num_(i.sold), 0);
    const prices = vj.items.map((i) => (num_(i.price) > 0 ? num_(i.price) : p.basePrice));
    p.price = Math.min.apply(null, prices);
    p.priceFrom = Math.max.apply(null, prices) !== p.price;
    vj.items.forEach((i) => { if (i.image && p.images.indexOf(i.image) < 0) p.images.push(i.image); });
  }
  return p;
}

const pid_ = (o) => String(o && o.id != null ? o.id : '').replace(/['"\s]/g, '');

/* ------------------------------------------------------------------ *
 * Public read (cached)
 * ------------------------------------------------------------------ */
function getPublic_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* ignore */ } }

  const products = table_(P).rows
    .filter((o) => o.status && String(o.status).toLowerCase() !== 'draft')
    .map(view_);
  const reviews = table_('Reviews').rows.filter((r) => r.status === 'shown');

  const by = {};
  reviews.forEach((r) => { const k = String(r.productId).trim(); (by[k] = by[k] || []).push(r); });
  products.forEach((p) => {
    const list = by[p.id] || [];
    p.reviewCount = list.length;
    p.rating = list.length ? Math.round((list.reduce((a, r) => a + num_(r.stars), 0) / list.length) * 10) / 10 : 0;
  });

  const payload = {
    version: VERSION,
    products: products.reverse(),
    settings: settings_(true),
    reviews: reviews.map((r) => ({
      id: String(r.id),
      productId: String(r.productId),
      stars: num_(r.stars),
      text: String(r.text || ''),
      name: String(r.name || ''),
      verified: !!r.orderRef,
      reply: String(r.reply || '')
    }))
  };

  try {
    const json = JSON.stringify(payload);
    if (json.length < 95000) cache.put(CACHE_KEY, json, CACHE_TTL); // CacheService caps values at 100 KB
  } catch (e) { /* cache is best effort */ }
  return payload;
}

function invalidate_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Web app entry points
 * ------------------------------------------------------------------ */
function doGet(e) {
  try {
    const q = (e && e.parameter) || {};
    let body = {};
    if (q.payload) { try { body = JSON.parse(q.payload); } catch (err) { body = {}; } }
    ['action', 'secret', 'token', 'url', 'productId', 'qty', 'variant', 'sessionId'].forEach((k) => {
      if (q[k] !== undefined && body[k] === undefined) body[k] = q[k];
    });
    return out_(route_(body.action || 'getPublic', body, true));
  } catch (err) {
    return out_({ error: errMsg_(err) });
  }
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return out_({ error: 'Empty request body.' });
    let d;
    try { d = JSON.parse(raw); } catch (err) { return out_({ error: 'Body must be JSON.' }); }
    if (!d || typeof d !== 'object') return out_({ error: 'Body must be a JSON object.' });
    return out_(route_(d.action || 'getPublic', d, false));
  } catch (err) {
    return out_({ error: errMsg_(err) });
  }
}

function adminOk_(d) {
  const real = prop_('SECRET_KEY');
  if (!real || String(real).length < 8) return false;   // cannot authorise when unset
  const given = d && d.secret != null ? String(d.secret) : '';
  if (!given) return false;
  return safeEqual_(given, String(real));
}

function route_(action, d, isGet) {
  d = d || {};
  switch (action) {
    case 'health': return health_();
    case 'get':
    case 'getPublic':
    case 'public': return getPublic_();
    case 'checkout': return checkout_(d);
    case 'confirmOrder': return confirmOrder_(d);
    case 'submitReview': return submitReview_(d);
    case 'myOrders': return myOrders_(d);
  }
  if (!adminOk_(d)) return { error: 'Unauthorized. Check the admin secret (run setup() to create one).' };
  switch (action) {
    case 'addProductAuto': return saveProductAuto(d.product || {});
    case 'adminGet': return adminGet_();
    case 'saveAll': return saveAll_(d);
    case 'createProduct': return createProduct_();
    case 'uploadImage': return d.data ? { url: imgbb_(d.data) } : { error: 'No image data received.' };
    case 'importUrl': return importUrl_(d.url);
    case 'syncPayments': return { success: true, updated: syncPayments(num_(d.limit) || 15) };
  }
  return { error: 'Unknown action: ' + action };
}

function health_() {
  return {
    ok: true,
    version: VERSION,
    sheets: [P, 'Reviews', 'Orders', 'Settings'].map((n) => !!sh_(n)),
    hasSecret: !!prop_('SECRET_KEY'),
    hasStripe: !!prop_('STRIPE_SECRET_KEY'),
    hasImgbb: !!prop_('IMGBB_API_KEY')
  };
}

/* ------------------------------------------------------------------ *
 * Customer login (Google Sign-In, verified server-side)
 * ------------------------------------------------------------------ */
function user_(token) {
  const cid = String(settings_(false).google_client_id || '').trim();
  if (!token || !cid) return null;
  const cache = CacheService.getScriptCache();
  const k = 'u' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))).slice(0, 40);
  const hit = cache.get(k);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* ignore */ } }
  try {
    const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(token)), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return null;
    const j = JSON.parse(r.getContentText());
    if (String(j.aud) !== cid) return null;
    if (String(j.email_verified) !== 'true' && j.email_verified !== true) return null;
    const u = { email: String(j.email || '').toLowerCase(), name: String(j.name || '') };
    if (!u.email) return null;
    cache.put(k, JSON.stringify(u), 1800);
    return u;
  } catch (e) {
    return null;
  }
}

function myOrders_(d) {
  const u = user_(d.token);
  if (!u) return { error: 'Please sign in again.' };
  const prods = {};
  table_(P).rows.forEach((p) => { prods[pid_(p)] = p; });
  const orders = table_('Orders').rows
    .filter((o) => o.status === 'paid' && (String(o.userEmail).toLowerCase() === u.email || String(o.email).toLowerCase() === u.email))
    .reverse()
    .map((o) => {
      const p = prods[String(o.productId).replace(/'/g, '')] || {};
      return {
        id: String(o.id).slice(0, 8).toUpperCase(),
        productId: String(o.productId),
        title: p.title || 'Product',
        image: images_(p)[0] || '',
        qty: o.qty,
        amount: o.amount,
        date: iso_(o.createdAt),
        status: String(o.status),
        shipStatus: o.shipStatus || 'processing',
        tracking: o.tracking || '',
        variant: String(o.variant || '').replace(/\|/g, ' / '),
        address: o.address || '',
        payment: o.payment || ''
      };
    });
  return { orders: orders, name: u.name };
}

/* ------------------------------------------------------------------ *
 * Customer reviews
 * ------------------------------------------------------------------ */
function submitReview_(d) {
  const u = user_(d.token);
  const text = String(d.text || '').trim().slice(0, 1000);
  const name = String(d.name || '').trim().slice(0, 60);
  const email = String(d.email || '').trim().toLowerCase().slice(0, 120);
  const stars = Math.min(5, Math.max(1, Math.round(num_(d.stars))));
  if (!text || !name || !/^\S+@\S+\.\S+$/.test(email)) return { error: 'Name, a valid email and your review are required.' };
  if (!table_(P).rows.find((r) => pid_(r) === String(d.productId))) return { error: 'Product not found.' };

  const rt = table_('Reviews');
  if (rt.rows.find((r) => String(r.productId) === String(d.productId) && String(r.email).toLowerCase() === email)) {
    return { error: 'You already reviewed this product.' };
  }

  let status = String(settings_(false).review_mode) === 'auto' ? 'shown' : 'pending';
  let ref = '';
  if (u && u.email === email) {
    const paid = table_('Orders').rows.find((r) => r.status === 'paid' && String(r.productId) === String(d.productId) && (String(r.userEmail).toLowerCase() === email || String(r.email).toLowerCase() === email));
    if (paid) { status = 'shown'; ref = String(paid.id); }
  }
  sh_('Reviews').appendRow([Utilities.getUuid(), d.productId, stars, safe_(text), safe_(name), ref, status, '', new Date().toISOString(), email]);
  invalidate_();
  return { success: true, published: status === 'shown' };
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */
function checkout_(d) {
  const key = prop_('STRIPE_SECRET_KEY');
  if (!key) return { error: 'Checkout is not available yet.' };

  const p = table_(P).rows.find((r) => pid_(r) === String(d.productId));
  if (!p) return { error: 'Product not found.' };

  const qty = Math.floor(num_(d.qty));
  const pre = bool_(p.preorder);
  const vj = vparse_(p);
  if (!(p.status === 'live' || (p.status === 'upcoming' && pre))) return { error: 'This deal is not available.' };

  let stock = Math.max(0, num_(p.qty));
  let price = num_(p.price);
  let name = String(p.title || '');
  let vkey = '';
  if (vj) {
    const it = vj.items.find((x) => x.key === fixKey_(d.variant, vj.options.length));
    if (!it) return { error: 'Please choose all options.' };
    stock = Math.max(0, num_(it.qty));
    if (num_(it.price) > 0) price = num_(it.price);
    vkey = it.key;
    name += ' (' + it.key.replace(/\|/g, ' / ') + ')';
  }
  if (qty < 1) return { error: 'Quantity must be at least 1.' };
  if (qty > stock) return { error: 'Only ' + stock + ' available.' };
  if (!(price > 0)) return { error: 'This product has no price yet.' };

  const u = user_(d.token);
  const site = String(settings_(false).site_url || '').replace(/\/+$/, '');
  if (!site) return { error: 'Set site_url in Admin → Settings first.' };

  const orderId = Utilities.getUuid();
  const payload = {
    mode: 'payment',
    'line_items[0][price_data][currency]': 'cad',
    'line_items[0][price_data][unit_amount]': Math.round(price * 100),
    'line_items[0][price_data][product_data][name]': (pre && p.status === 'upcoming' ? '[Pre-order] ' : '') + name,
    'line_items[0][quantity]': qty,
    'shipping_address_collection[allowed_countries][0]': 'CA',
    'phone_number_collection[enabled]': 'true',
    client_reference_id: orderId,
    'metadata[orderId]': orderId,
    'metadata[productId]': String(d.productId),
    'metadata[variant]': vkey,
    success_url: site + '/account.html?paid=1&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: site + '/product.html?id=' + encodeURIComponent(String(d.productId))
  };
  if (u) payload.customer_email = u.email;
  const img = images_(p)[0];
  if (isUrl_(img) && /^https:\/\//.test(img)) payload['line_items[0][price_data][product_data][images][0]'] = img;

  let j;
  try {
    const res = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'post',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key },
      payload: payload
    });
    j = JSON.parse(res.getContentText());
  } catch (e) {
    return { error: 'Could not reach Stripe. ' + errMsg_(e) };
  }
  if (!j || !j.url) return { error: (j && j.error && j.error.message) || 'Stripe error.' };

  sh_('Orders').appendRow([orderId, d.productId, qty, price * qty, j.id, 'pending', '', new Date().toISOString(), '', '', '', '', u ? u.email : '', '', '', vkey]);
  invalidate_();
  return { url: j.url };
}

function fetchSession_(id) {
  const key = prop_('STRIPE_SECRET_KEY');
  if (!key || !/^cs_[\w]+$/.test(String(id || ''))) return null;
  try {
    const r = UrlFetchApp.fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(String(id)) + '?expand[]=payment_intent.payment_method', {
      headers: { Authorization: 'Bearer ' + key },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) return null;
    return JSON.parse(r.getContentText());
  } catch (e) {
    return null;
  }
}

function stockCache_() {
  return { pt: table_(P), ot: table_('Orders'), touched: {} };
}

function touch_(cache, row, key, value) {
  const k = String(row);
  if (!cache.touched[k]) cache.touched[k] = {};
  cache.touched[k][key] = value;
}

function flushStock_(cache) {
  Object.keys(cache.touched).forEach((row) => updateRow_(cache.pt, Number(row), cache.touched[row]));
}

/** Marks one order paid (idempotent) and moves stock. */
function applyPaid_(o, s, cache) {
  if (String(o.status) === 'paid') return false;

  const qty = Math.floor(num_(o.qty));
  const productId = pid_({ id: o.productId });
  const p = cache.pt.rows.find((r) => pid_(r) === productId);
  if (p) {
    const vj = vparse_(p);
    const it = o.variant && vj ? vj.items.find((x) => x.key === fixKey_(o.variant, vj.options.length)) : null;
    if (it) {
      it.qty = Math.max(0, num_(it.qty) - qty);
      it.sold = num_(it.sold) + qty;
      p.variantsJson = JSON.stringify(vj);
      touch_(cache, p._row, 'variantsJson', p.variantsJson);
    } else {
      p.qty = Math.max(0, num_(p.qty) - qty);
      p.sold = num_(p.sold) + qty;
      touch_(cache, p._row, 'qty', p.qty);
      touch_(cache, p._row, 'sold', p.sold);
    }
  }

  const cd = s.customer_details || {};
  const sd = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const a = sd.address || cd.address || {};
  const pi = s.payment_intent;
  const pm = pi && pi.payment_method;
  let payment = '';
  if (pm) payment = String(pm.type || 'card') + (pm.card ? ' ' + pm.card.brand + ' ****' + pm.card.last4 : '');
  else if (s.payment_method_types && s.payment_method_types.length) payment = String(s.payment_method_types[0]);

  updateRow_(cache.ot, o._row, {
    status: 'paid',
    email: String(cd.email || ''),
    name: safe_(sd.name || cd.name || ''),
    phone: safe_(cd.phone || ''),
    address: safe_([a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')),
    payment: payment,
    shipStatus: 'processing'
  });
  o.status = 'paid';
  return true;
}

/** Called by account.html right after Stripe: applies the payment immediately. */
function confirmOrder_(d) {
  const id = String(d.sessionId || '').trim();
  const s = fetchSession_(id);
  if (!s) return { ok: false, error: 'Could not verify this payment.' };
  const cache = stockCache_();
  const o = cache.ot.rows.find((r) => String(r.stripeSessionId) === id);
  if (!o) return { ok: false, error: 'Order not found for this payment.' };
  const changed = applyPaid_(o, s, cache);
  flushStock_(cache);
  invalidate_();
  return { ok: true, updated: changed ? 1 : 0, paid: String(o.status) === 'paid' };
}

function syncPayments(limit) {
  const key = prop_('STRIPE_SECRET_KEY');
  if (!key) return 0;
  const max = Math.max(1, Math.min(40, Math.floor(num_(limit)) || 40));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return 0;
  try {
    const cache = stockCache_();
    let n = 0;
    cache.ot.rows
      .filter((r) => String(r.status) === 'pending' && String(r.stripeSessionId || '').trim())
      .slice(0, max)
      .forEach((o) => {
        const s = fetchSession_(String(o.stripeSessionId));
        if (!s) return;
        if (s.payment_status === 'paid') {
          if (applyPaid_(o, s, cache)) n++;
        } else if (s.status === 'expired') {
          updateRow_(cache.ot, o._row, { status: 'expired' });
        }
      });
    flushStock_(cache);
    if (n) invalidate_();
    return n;
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ *
 * Admin read / write
 * ------------------------------------------------------------------ */
function adminGet_() {
  const ps = PropertiesService.getScriptProperties();
  return {
    version: VERSION,
    products: table_(P).rows.map((o) => view_(o)).reverse(),
    reviews: table_('Reviews').rows.map((r) => ({
      id: String(r.id),
      productId: String(r.productId),
      stars: num_(r.stars),
      text: String(r.text || ''),
      name: String(r.name || ''),
      orderRef: String(r.orderRef || ''),
      email: String(r.email || ''),
      status: String(r.status || 'pending'),
      reply: String(r.reply || '')
    })).reverse(),
    settings: settings_(false),
    keysSet: {
      STRIPE_SECRET_KEY: !!ps.getProperty('STRIPE_SECRET_KEY'),
      IMGBB_API_KEY: !!ps.getProperty('IMGBB_API_KEY'),
      SECRET_KEY: !!ps.getProperty('SECRET_KEY')
    },
    orders: table_('Orders').rows
      .filter((r) => String(r.status) !== 'expired')
      .slice(-100)
      .reverse()
      .map((r) => ({
        id: String(r.id),
        productId: String(r.productId),
        qty: r.qty,
        amount: r.amount,
        status: String(r.status),
        email: String(r.email || ''),
        name: String(r.name || ''),
        address: String(r.address || ''),
        phone: String(r.phone || ''),
        payment: String(r.payment || ''),
        variant: String(r.variant || '').replace(/\|/g, ' / '),
        shipStatus: String(r.shipStatus || ''),
        tracking: String(r.tracking || ''),
        createdAt: iso_(r.createdAt)
      }))
  };
}

function saveAll_(d) {
  if (d.keys && d.keys.SECRET_KEY && String(d.keys.SECRET_KEY).trim().length < 12) {
    return { error: 'New admin secret must be at least 12 characters.' };
  }
  if (d.newReview) {
    const n = d.newReview;
    if (!n.productId || !String(n.text || '').trim() || !String(n.name || '').trim() || !String(n.orderRef || '').trim()) {
      return { error: 'A new review needs a product, name, text and a real order reference.' };
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const t = table_(P);
    const delP = [];

    (d.products || []).forEach((u) => {
      const p = t.rows.find((r) => pid_(r) === String(u.id));
      if (!p) return;
      const f = u.fields || {};
      if (bool_(f._del)) { delP.push(p._row); return; }

      const patch = {};
      PRODUCT_FIELDS.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(f, k)) patch[k] = (k === 'title' || k === 'description') ? safe_(f[k]) : f[k];
      });
      if (Array.isArray(f.images)) patch.imagesJson = JSON.stringify(f.images.filter(isUrl_));
      if (Object.prototype.hasOwnProperty.call(f, 'variants')) patch.variantsJson = normVariants_(f.variants, vparse_(p));

      const offline = Math.floor(num_(f.offline));
      if (offline > 0 && !vparse_(p)) {
        // Stock/sold may be edited directly as well; apply the offline sale on
        // top of whatever the form submitted, never instead of it.
        const baseQty = Object.prototype.hasOwnProperty.call(f, 'qty') ? num_(f.qty) : num_(p.qty);
        const baseSold = Object.prototype.hasOwnProperty.call(f, 'sold') ? num_(f.sold) : num_(p.sold);
        patch.qty = Math.max(0, baseQty - offline);
        patch.sold = baseSold + offline;
      }
      updateRow_(t, p._row, patch);
    });

    if (d.settings) setSettings_(d.settings);

    if ((d.reviews || []).length) {
      const rt = table_('Reviews');
      const delR = [];
      d.reviews.forEach((u) => {
        const r = rt.rows.find((x) => String(x.id) === String(u.id));
        if (!r) return;
        if (bool_(u._del)) { delR.push(r._row); return; }
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(u, 'status')) {
          patch.status = ['shown', 'hidden', 'pending'].indexOf(u.status) >= 0 ? u.status : 'hidden';
        }
        if (Object.prototype.hasOwnProperty.call(u, 'reply')) patch.reply = safe_(u.reply);
        updateRow_(rt, r._row, patch);
      });
      delR.sort((a, b) => b - a).forEach((row) => rt.s.deleteRow(row));
    }

    if ((d.orders || []).length) {
      const ot = table_('Orders');
      d.orders.forEach((u) => {
        const r = ot.rows.find((x) => String(x.id) === String(u.id));
        if (!r) return;
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(u, 'shipStatus')) patch.shipStatus = u.shipStatus;
        if (Object.prototype.hasOwnProperty.call(u, 'tracking')) patch.tracking = safe_(u.tracking);
        updateRow_(ot, r._row, patch);
      });
    }

    if (d.newReview) {
      const n = d.newReview;
      sh_('Reviews').appendRow([
        Utilities.getUuid(), n.productId, Math.min(5, Math.max(1, Math.round(num_(n.stars)))),
        safe_(n.text), safe_(n.name), safe_(n.orderRef), 'shown', '', new Date().toISOString(), ''
      ]);
    }

    // Products last: deleting rows shifts everything below them.
    delP.sort((a, b) => b - a).forEach((row) => t.s.deleteRow(row));

    if (d.keys) setKeys_(d.keys);
    invalidate_();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function setSettings_(values) {
  const t = table_('Settings');
  Object.keys(values || {}).forEach((k) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) return;
    const v = String(values[k] == null ? '' : values[k]).slice(0, 5000);
    const r = t.rows.find((x) => String(x.key) === k);
    if (r) t.s.getRange(r._row, 2).setValue(v);
    else t.s.appendRow([k, v]);
  });
}

function createProduct_() {
  const id = Utilities.getUuid();
  sh_(P).appendRow([id, 'New product', 0, '', '[]', 'daily', '', new Date().toISOString(), 0, 0, 'draft', 'FALSE', '', '', '']);
  invalidate_();
  return { success: true, id: id };
}

/* ------------------------------------------------------------------ *
 * Images (ImgBB)
 * ------------------------------------------------------------------ */
function imgbb_(b64) {
  const key = prop_('IMGBB_API_KEY');
  if (!key) throw new Error('IMGBB_API_KEY is not set (Admin → Settings → Private keys).');
  if (!b64) throw new Error('No image data.');
  const res = UrlFetchApp.fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key), {
    method: 'post',
    muteHttpExceptions: true,
    payload: { image: b64, expiration: 0 }
  });
  let j;
  try { j = JSON.parse(res.getContentText()); } catch (e) { throw new Error('ImgBB returned HTTP ' + res.getResponseCode()); }
  if (!j.success || !j.data) throw new Error('ImgBB: ' + ((j.error && (j.error.message || j.error.code)) || 'upload failed'));
  return j.data.url || j.data.display_url;
}

function uploadToImgbb_(url) {
  const src = String(url || '').trim();
  if (!isUrl_(src)) throw new Error('not a URL');
  const origin = (src.match(/^https?:\/\/[^\/]+/) || [''])[0] + '/';
  const res = UrlFetchApp.fetch(src, {
    headers: {
      'User-Agent': UA,
      Referer: origin,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    },
    muteHttpExceptions: true,
    followRedirects: true
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('download HTTP ' + code);
  const blob = res.getBlob();
  const type = String(blob.getContentType() || '').toLowerCase();
  if (type && type.indexOf('image') < 0 && type.indexOf('octet-stream') < 0) throw new Error('not an image (' + type + ')');
  const bytes = blob.getBytes();
  if (bytes.length < 1024) throw new Error('image too small');
  return imgbb_(Utilities.base64Encode(bytes));
}

/** Products created by the extension / mobile importer. */
function saveProductAuto(product) {
  product = product || {};
  const title = String(product.title || '').trim();
  if (!title) return { error: 'Product title is required.' };
  const price = num_(product.price);
  if (!(price > 0)) return { error: 'Price must be a number greater than 0.' };

  const saved = [];
  const failed = [];
  const map = {};

  (product.images || []).slice(0, 15).forEach((raw) => {
    const src = String(raw || '').trim();
    if (!isUrl_(src)) return;
    try {
      const hosted = uploadToImgbb_(src);
      saved.push(hosted);
      map[src] = hosted;
    } catch (e) {
      // Keep the original URL so the product is never image-less; admin can replace it.
      saved.push(src);
      map[src] = src;
      failed.push({ url: src, reason: errMsg_(e) });
    }
  });

  let vj = '';
  if (product.variants && Array.isArray(product.variants.options) && product.variants.options.length) {
    let extra = 0;
    (product.variants.items || []).forEach((it) => {
      if (!it || !it.image) return;
      const src = String(it.image).trim();
      if (!isUrl_(src)) { it.image = ''; return; }
      if (map[src]) { it.image = map[src]; return; }
      if (extra >= 20) { it.image = src; return; }
      extra++;
      try { map[src] = uploadToImgbb_(src); } catch (e) { map[src] = src; }
      it.image = map[src];
    });
    vj = normVariants_(product.variants, null);
  }

  // Stock: variants carry their own numbers, otherwise start at 1 so the
  // product is never published as "Sold out".
  const qty = vj ? 0 : Math.max(1, Math.floor(num_(product.qty) || 1));
  const id = Utilities.getUuid();
  sh_(P).appendRow([
    id,
    safe_(title),
    price,
    safe_(product.description || ''),
    JSON.stringify(saved),
    String(product.dealType || 'daily'),
    String(product.stripeLink || ''),
    new Date().toISOString(),
    qty,
    0,
    IMPORT_STATUS,
    'FALSE',
    '',
    '',
    vj
  ]);
  invalidate_();
  return {
    success: true,
    id: id,
    status: IMPORT_STATUS,
    images: saved,
    failed: failed,
    variants: vj ? JSON.parse(vj).items.length : 0
  };
}

/**
 * Phone-friendly import. Stores source image URLs first and only spends up to
 * ~6s on ImgBB so the Netlify function (10s budget) does not time out.
 */
function importUrl_(url) {
  if (!isUrl_(url)) return { error: 'Paste a full link starting with https://' };
  let html;
  try {
    const res = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-CA,en;q=0.9' },
      muteHttpExceptions: true,
      followRedirects: true
    });
    if (res.getResponseCode() !== 200) return { error: 'The site returned HTTP ' + res.getResponseCode() + '. Add the product manually.' };
    html = res.getContentText();
  } catch (e) {
    return { error: 'Could not download this page. Add the product manually.' };
  }

  const dec = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
  const meta = (p) => {
    const a = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'));
    if (a) return dec(a[1]);
    const b = html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + p + '["\']', 'i'));
    return b ? dec(b[1]) : '';
  };

  let title = meta('og:title');
  let price = meta('product:price:amount') || meta('og:price:amount');
  let desc = meta('og:description');
  const imgs = [];
  if (meta('og:image')) imgs.push(meta('og:image'));

  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      const nodes = Array.isArray(j) ? j : (j['@graph'] || [j]);
      nodes.forEach((it) => {
        if (!it) return;
        const type = Array.isArray(it['@type']) ? it['@type'].join(',') : String(it['@type'] || '');
        if (type.indexOf('Product') < 0) return;
        title = title || String(it.name || '');
        desc = desc || String(it.description || '');
        const offers = Array.isArray(it.offers) ? it.offers[0] : it.offers;
        if (offers) price = price || offers.price || offers.lowPrice || '';
        [].concat(it.image || []).forEach((x) => {
          const u = typeof x === 'string' ? x : (x && x.url);
          if (u) imgs.push(u);
        });
      });
    } catch (e) { /* ignore malformed JSON-LD */ }
  }
  if (!title) return { error: 'Could not read this page (the site blocks bots). Use the desktop extension, or add the product manually.' };

  const clean = [];
  imgs.forEach((u) => {
    let s = String(u || '').trim();
    if (!isUrl_(s)) return;
    if (/\bcdn\.shopify\.com\b|\bshopifycdn\.com\b/.test(s)) s = s.replace(/_\d+x\d*(?=\.(?:jpe?g|png|webp))/i, '');
    s = s.replace(/([?&])(w|width|h|height|q|quality|fit|resize|size)=[^&]*/gi, '$1').replace(/[?&]+$/, '');
    if (clean.indexOf(s) < 0) clean.push(s);
  });

  const started = Date.now();
  const hosted = [];
  let failed = 0;
  clean.slice(0, 10).forEach((u, i) => {
    if (prop_('IMGBB_API_KEY') && i < 3 && Date.now() - started < 6000) {
      try { hosted.push(uploadToImgbb_(u)); return; } catch (e) { failed++; }
    }
    hosted.push(u);
  });

  const created = saveProductAuto({
    title: title,
    price: num_(price),
    description: desc ? '<p>' + dec(desc) + '</p>' : '',
    images: hosted
  });
  if (created.error) return created;
  return { success: true, id: created.id, images: created.images, failed: failed, status: created.status };
}

/* ------------------------------------------------------------------ *
 * Variants normaliser (also keeps stock history when options are edited)
 * ------------------------------------------------------------------ */
function normVariants_(v, old) {
  if (!v || !Array.isArray(v.options)) return '';
  const opts = [];
  v.options.slice(0, 3).forEach((o) => {
    const name = cleanV_(o && o.name).slice(0, 30);
    if (!name) return;
    const values = [];
    (Array.isArray(o.values) ? o.values : []).forEach((x) => {
      const c = cleanV_(x);
      if (c && values.indexOf(c) < 0 && values.length < 30) values.push(c);
    });
    if (values.length) opts.push({ name: name, values: values });
  });
  if (!opts.length) return '';

  const combos = opts.reduce((acc, o) => {
    const next = [];
    acc.forEach((a) => {
      o.values.forEach((val) => {
        if (next.length < 150) next.push(a.concat([val]));
      });
    });
    return next;
  }, [[]]);

  const given = {};
  (v.items || []).forEach((it) => {
    if (!it) return;
    let key = it.key ? fixKey_(it.key, opts.length) : '';
    if (!key && Array.isArray(it.values)) key = it.values.map(cleanV_).join('|');
    if (key) given[key] = it;
  });
  const oldSold = {};
  ((old && old.items) || []).forEach((it) => { oldSold[it.key] = num_(it.sold); });

  const items = combos.map((vals) => {
    const key = vals.join('|');
    const g = given[key] || {};
    // Sold may be edited by hand; only fall back to the stored value when the
    // caller did not supply one (e.g. an import that has no sales history).
    const soldGiven = g.sold !== undefined && g.sold !== null && g.sold !== '';
    return {
      key: key,
      price: num_(g.price) > 0 ? num_(g.price) : '',
      qty: Math.max(0, Math.floor(num_(g.qty))),
      sold: soldGiven ? Math.max(0, Math.floor(num_(g.sold))) : (oldSold[key] || 0),
      image: isUrl_(g.image) ? String(g.image) : ''
    };
  });
  return JSON.stringify({ options: opts, items: items });
}

/* ------------------------------------------------------------------ *
 * Private keys (write-only, Script Properties — never in the Sheet)
 * ------------------------------------------------------------------ */
function setKeys_(k) {
  const props = {};
  ['STRIPE_SECRET_KEY', 'IMGBB_API_KEY', 'SECRET_KEY'].forEach((n) => {
    const v = String((k || {})[n] || '').trim();
    if (v) props[n] = v;
  });
  if (!Object.keys(props).length) return;
  PropertiesService.getScriptProperties().setProperties(props, false);
}
