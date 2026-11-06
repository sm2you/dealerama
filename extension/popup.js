/**
 * Dealerama Importer — popup + page scrapers
 * ---------------------------------------------------------------------------
 * WHY VARIANTS USED TO BE "none":
 *   chrome.scripting.executeScript({ func }) runs in the ISOLATED world, which
 *   cannot see page globals such as window.ShopifyAnalytics. Every Shopify
 *   variant read therefore returned undefined. Variants are now extracted twice
 *   — once in the MAIN world (page globals + same-origin fetch) and once in the
 *   isolated world (DOM) — and the richer result wins.
 *
 * The variant key is also normalised to "Colour|Size" (pipe separated) because
 * that is exactly what the admin grid and product.html compare against.
 */

const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const scrapeBtn = document.getElementById('scrapeBtn');

scrapeBtn.addEventListener('click', async () => {
  scrapeBtn.disabled = true;
  summaryEl.style.display = 'none';
  statusEl.className = '';
  statusEl.textContent = 'Scraping the page...';

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    statusEl.textContent = 'Could not read the active tab.';
    scrapeBtn.disabled = false;
    return;
  }
  if (!tab || !tab.id) {
    statusEl.textContent = 'No active tab.';
    scrapeBtn.disabled = false;
    return;
  }
  if (/^(chrome|edge|about|view-source|chrome-extension):/i.test(tab.url || '')) {
    statusEl.textContent = 'Open a real product page first (not a browser page).';
    scrapeBtn.disabled = false;
    return;
  }

  try {
    const iso = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: runScrapeInPage });
    const data = (iso && iso[0] && iso[0].result) || null;
    if (!data || !data.title) {
      statusEl.textContent = 'Could not read this page. Scroll the product page fully, then try again.';
      scrapeBtn.disabled = false;
      return;
    }

    statusEl.textContent = 'Looking for variants...';
    let variants = null;
    try {
      const [mainWorld, isolated] = await Promise.all([
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, func: extractVariants, world: 'MAIN' })
          .catch(() => null),
        chrome.scripting
          .executeScript({ target: { tabId: tab.id }, func: extractVariants })
          .catch(() => null)
      ]);
      variants = pickVariants(
        mainWorld && mainWorld[0] ? mainWorld[0].result : null,
        isolated && isolated[0] ? isolated[0].result : null
      );
    } catch (e) {
      variants = null;
    }

    data.variants = variants;
    data.pageUrl = tab.url || data.pageUrl || '';
    data.scrapedAt = new Date().toISOString();
    data.images = mergeVariantImages(data.images || [], variants);

    await chrome.storage.local.set({ draftProduct: data, draftSavedAt: data.scrapedAt });

    renderSummary(data);
    statusEl.textContent = 'Saved. Opening the review tab...';
    setTimeout(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL('staging.html') });
      window.close();
    }, 700);
  } catch (e) {
    statusEl.textContent = 'ERROR: ' + (e && e.message ? e.message : e);
    statusEl.className = 'warn';
    scrapeBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ *
 * Result merging
 * ------------------------------------------------------------------ */
function pickVariants(mainResult, isolatedResult) {
  const candidates = [mainResult, isolatedResult].filter(
    (r) => r && Array.isArray(r.items) && r.items.length
  );
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    const score = (x) => (x.options && x.options.length ? 1 : 0) + (x.source !== 'none' ? 1 : 0);
    return score(b) - score(a);
  });

  const best = candidates[0];
  if (!best.options || !best.options.length) return null;
  if (best.items.length < 2) return null; // a single variant is not a variant

  const seen = {};
  const items = best.items
    .filter((it) => it && it.key && !seen[it.key] && (seen[it.key] = 1))
    .slice(0, 200)
    .map((it) => ({
      key: String(it.key),
      price: Number(it.price) > 0 ? Math.round(Number(it.price) * 100) / 100 : null,
      qty: Math.max(0, Math.round(Number(it.qty) || 0)),
      sold: Math.max(0, Math.round(Number(it.sold) || 0)),
      image: it.image || null
    }));

  return {
    source: best.source || 'unknown',
    options: best.options.map((o) => ({
      name: String(o.name || '').trim(),
      values: (o.values || []).map((v) => String(v)).filter(Boolean)
    })).filter((o) => o.name && o.values.length),
    items
  };
}

function mergeVariantImages(images, variants) {
  const out = (images || []).slice();
  if (!variants || !variants.items) return out;
  variants.items.forEach((it) => {
    if (it.image && out.indexOf(it.image) === -1 && out.length < 20) out.push(it.image);
  });
  return out;
}

function renderSummary(data) {
  const v = data.variants;
  const rows = [
    ['Title', (data.title || '').slice(0, 42) + (data.title && data.title.length > 42 ? '…' : '')],
    ['Price', data.price ? '$' + Number(data.price).toFixed(2) : 'not found'],
    ['Images', String((data.images || []).length)],
    [
      'Variants',
      v && v.items.length
        ? '<span class="good">' + v.items.length + ' (' + (v.source || 'auto') + ')</span>'
        : '<span class="warn">none found</span>'
    ]
  ];
  summaryEl.innerHTML = rows
    .map(([k, val]) => `<div><span>${k}</span><b>${val}</b></div>`)
    .join('');
  summaryEl.style.display = 'block';
}

/* ================================================================== *
 * INJECTED: DOM scraper (isolated world — images, title, price, text)
 * ================================================================== */
async function runScrapeInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = location.hostname;
  const isAmazon = /(^|\.)amazon\./i.test(host);
  const isShopify =
    !!document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], meta[name="shopify-checkout-api-token"]');

  const norm = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s || /^data:/i.test(s)) return '';
    try { s = new URL(s, location.href).href; } catch (e) { return ''; }
    return s.replace(/^http:\/\//i, 'https://');
  };

  const cleanImage = (raw) => {
    let u = norm(raw);
    if (!u) return '';
    if (!/\.(jpe?g|png|webp)(\?|#|$)/i.test(u) && !/media-amazon|shopify|imgbb|cloudinary|bigcommerce|wixstatic/i.test(u)) return '';
    if (isAmazon) {
      u = u.split('?')[0].split('#')[0];
      u = u.replace(/\._[A-Za-z0-9_,%\-]+_?\.(jpe?g|png|webp)$/i, '.$1');
    } else {
      if (/shopify/i.test(u)) {
        u = u
          .replace(/_\d+x\d*(?=\.(?:jpe?g|png|webp))/i, '')
          .replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|\d+x\d*)(?=\.(?:jpe?g|png|webp))/i, '');
      }
      u = u.replace(/#.*$/, '');
      u = u.replace(/([?&])(w|width|h|height|q|quality|fit|resize|size|sw|sh|ow|oh)=[^&]*/gi, '$1');
      u = u.replace(/[?&]+$/, '').replace(/\?&/, '?');
    }
    return u;
  };

  // Scroll so lazy images and long descriptions are loaded.
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    window.scrollBy(0, Math.max(window.innerHeight, 600));
    await sleep(250);
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (h === prev) break;
    prev = h;
  }
  window.scrollTo(0, 0);
  await sleep(300);

  const textOf = (el) => (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  const stripTags = (s) =>
    String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const parsePrice = (input) => {
    if (input == null) return null;
    if (typeof input === 'number' && isFinite(input)) return input;
    const s = String(input).replace(/\u00a0/g, ' ');
    const m = s.match(/(?:CA\$|C\$|\$|USD|CAD)?\s*([0-9][0-9.,]*)(?:\s*(?:CAD|USD))?/i);
    if (!m) return null;
    let raw = m[1];
    // 1,299.99 -> 1299.99 | 1.299,99 -> 1299.99
    if (/,\d{2}$/.test(raw) && raw.indexOf('.') > -1) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
    const n = parseFloat(raw);
    return isFinite(n) && n > 0 ? n : null;
  };

  /* ---------- structured data ---------- */
  let title = '';
  let price = null;
  let description = '';
  const jsonLdImages = [];
  const jsonLdOffers = [];

  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const types = [].concat(item['@type'] || []).map(String);
    if (types.some((t) => t.toLowerCase() === 'product' || t.toLowerCase() === 'productgroup')) {
      title = title || String(item.name || '');
      description = description || String(item.description || '');
      [].concat(item.image || []).forEach((x) => {
        const u = typeof x === 'string' ? x : x && (x.url || x.contentUrl);
        if (u) jsonLdImages.push(u);
      });
      [].concat(item.offers || []).forEach((o) => {
        if (!o) return;
        jsonLdOffers.push(o);
        if (price == null) {
          const p = o.price || o.lowPrice || (o.priceSpecification && o.priceSpecification.price);
          if (p != null) price = parsePrice(p);
        }
      });
      [].concat(item.hasVariant || []).forEach((v) => {
        const o = [].concat(v.offers || [])[0];
        if (o && price == null) price = parsePrice(o.price);
      });
    }
    if (item['@graph']) visit(item['@graph']);
  };

  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { visit(JSON.parse(s.textContent)); } catch (e) { /* malformed JSON-LD */ }
  });

  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.getAttribute('content') || '').trim() : '';
  };

  /* ---------- title ---------- */
  title =
    title ||
    textOf(document.querySelector('#productTitle, #title, h1[itemprop="name"], .product_title, .product-title, h1')) ||
    meta('meta[property="og:title"]') ||
    document.title;
  title = String(title || '').replace(/\s+/g, ' ').trim();

  /* ---------- price ---------- */
  const priceSelectors = isAmazon
    ? ['#corePrice_feature_div .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice', 'span.a-price .a-offscreen', '#price_inside_buybox', '#tp_price_block_total_price_ww .a-offscreen']
    : [
        '.summary .price .amount', '.price .amount', 'p.price ins .amount', '.woocommerce-Price-amount',
        '[itemprop="price"]', '.product__price', '.price--main', '.price-item--regular'
      ];
  if (price == null) {
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const candidate = parsePrice(el.getAttribute('content') || el.getAttribute('data-price') || el.textContent);
      if (candidate) { price = candidate; break; }
    }
  }
  if (price == null) price = parsePrice(meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]'));

  /* ---------- description ---------- */
  const descSelectors = isAmazon
    ? ['#productDescription', '#bookDescription_feature_div']
    : ['.woocommerce-product-details__short-description', '.product-description', '#tab-description', '[itemprop="description"]', '.rte'];
  for (const sel of descSelectors) {
    if (description && description.length > 80) break;
    const el = document.querySelector(sel);
    if (el) description = stripTags(el.innerHTML) || description;
  }
  description = stripTags(description || meta('meta[property="og:description"]') || meta('name="description"'));

  /* ---------- images ---------- */
  const candidates = [];
  const add = (raw) => {
    const u = cleanImage(raw);
    if (!u || candidates.indexOf(u) > -1) return;
    candidates.push(u);
  };

  if (isAmazon) {
    const dynEl = document.querySelector('#landingImage, #imgBlkFront, #main-image');
    const dyn = dynEl && dynEl.getAttribute('data-a-dynamic-image');
    if (dyn) {
      try {
        const parsed = JSON.parse(dyn);
        Object.keys(parsed)
          .sort((a, b) => (parsed[b][0] || 0) - (parsed[a][0] || 0))
          .forEach(add);
      } catch (e) { /* ignore */ }
    }
    document.querySelectorAll('#altImages img, #imageBlock img, #main-image-container img').forEach((i) => {
      add(i.getAttribute('data-old-hires'));
      add(i.getAttribute('data-src'));
      add(i.src);
    });
  }

  add(meta('meta[property="og:image"]'));
  add(meta('meta[property="og:image:secure_url"]'));
  jsonLdImages.forEach(add);

  Array.from(document.images).forEach((img) => {
    if (img.naturalWidth && img.naturalWidth < 120) return;
    add(img.getAttribute('data-zoom-image'));
    add(img.getAttribute('data-large_image'));
    add(img.getAttribute('data-large'));
    add(img.getAttribute('data-zoom'));
    add(img.getAttribute('data-old-hires'));
    if (img.srcset) {
      const best = String(img.srcset)
        .split(',')
        .map((x) => x.trim().split(/\s+/))
        .filter((p) => p[0])
        .sort((a, b) => (parseInt(b[1], 10) || 0) - (parseInt(a[1], 10) || 0))[0];
      if (best) add(best[0]);
    }
    add(img.currentSrc || img.src);
  });

  const BAD = /sprite|placeholder|grey-pixel|transparent-pixel|\/icon|favicon|logo|badge|star|rating|swatch|banner-ad|loading|spinner|pixel\.(gif|png)/i;
  const images = candidates.filter((u) => !BAD.test(u)).slice(0, 20);

  return {
    title: title || '',
    price: price || null,
    description: description || '',
    images: images,
    pageUrl: location.href,
    host: host,
    store: isAmazon ? 'amazon' : isShopify ? 'shopify' : /woocommerce/i.test(document.documentElement.className) ? 'woocommerce' : 'generic'
  };
}

/* ================================================================== *
 * INJECTED: variant extractor (runs in MAIN *and* isolated world)
 * ------------------------------------------------------------------
 * MAIN world: window.ShopifyAnalytics / window.product / same-origin
 *             Shopify .js endpoint.
 * Isolated:   DOM JSON scripts, WooCommerce data-product_variations,
 *             Amazon twister data, generic selects, JSON-LD.
 * ================================================================== */
async function extractVariants() {
  const R = { source: 'none', options: [], items: [], hint: '' };
  const val = (x) => String(x == null ? '' : x).trim();
  const isDefault = (s) => /^(default title|title|default|n\/a)$/i.test(val(s));

  const absUrl = (u) => {
    if (!u || typeof u !== 'string') return '';
    let s = u.trim();
    if (!s || /^data:/i.test(s)) return '';
    try { s = new URL(s, location.href).href; } catch (e) { return ''; }
    if (/^\/\//.test(s)) s = 'https:' + s;
    return s;
  };

  const cleanImg = (u) => {
    let s = absUrl(u);
    if (!s) return '';
    s = s.split('#')[0];
    if (/shopify|\.shopify\.com/i.test(s)) {
      s = s.replace(/_\d+x\d*(?=\.(?:jpe?g|png|webp))/i, '');
      s = s.replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande)(?=\.(?:jpe?g|png|webp))/i, '');
    }
    return s.replace(/([?&])(w|width|h|height|q|quality|fit|resize|size)=[^&]*/gi, '$1').replace(/[?&]+$/, '').replace(/^http:\/\//i, 'https://');
  };

  const money = (v, cents) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return cents ? v / 100 : v;
    const s = String(v).replace(/[^0-9.,\-]/g, '');
    if (!s) return null;
    const n = parseFloat(cents ? s : s.replace(/,/g, ''));
    return isFinite(n) ? (cents ? n / 100 : n) : null;
  };

  const pagePrice = () => {
    const off = document.querySelector('#corePrice_feature_div .a-offscreen, span.a-price .a-offscreen, #priceblock_ourprice, .price .amount, .woocommerce-Price-amount, [itemprop="price"]');
    if (off) {
      const n = parseFloat(String(off.getAttribute('content') || off.textContent).replace(/[^0-9.]/g, ''));
      if (isFinite(n) && n > 0) return n;
    }
    const meta = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]');
    if (meta) {
      const n = parseFloat(String(meta.getAttribute('content') || '').replace(/[^0-9.]/g, ''));
      if (isFinite(n) && n > 0) return n;
    }
    return null;
  };

  const addItem = (key, price, qty, image, sold) => {
    const k = val(key);
    if (!k) return;
    R.items.push({
      key: k,
      price: price == null ? null : price,
      qty: qty == null ? 10 : Math.max(0, Math.round(qty)),
      image: cleanImg(image) || null,
      sold: sold || 0
    });
  };

  const setOptions = (names, perIndex) => {
    R.options = names.map((n, i) => ({
      name: val(n) || 'Option ' + (i + 1),
      values: (perIndex[i] || []).filter((v, k, a) => v && a.indexOf(v) === k)
    })).filter((o) => o.values.length);
  };

  const finish = (source) => {
    R.source = source;
    const seen = {};
    R.items = R.items.filter((it) => {
      if (!it.key || seen[it.key]) return false;
      seen[it.key] = 1;
      return true;
    });
    if (!R.options.length && R.items.length) {
      const width = R.items[0].key.split('|').length;
      const perIndex = [];
      for (let i = 0; i < width; i++) perIndex.push([]);
      R.items.forEach((it) => {
        it.key.split('|').forEach((part, i) => {
          if (perIndex[i] && perIndex[i].indexOf(part) < 0) perIndex[i].push(part);
        });
      });
      R.options = perIndex.map((values, i) => ({
        name: width === 1 ? 'Option' : 'Option ' + (i + 1),
        values: values
      }));
    }
    return R.items.length ? R : null;
  };

  /* ---------------- 1. Shopify globals (MAIN world) ---------------- */
  try {
    const sa = window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product;
    if (sa && Array.isArray(sa.variants) && sa.variants.length) {
      const names = (sa.options || []).map((o) => val(o.name || o));
      const perIndex = names.map(() => []);
      sa.variants.forEach((v) => {
        const parts = [v.option1, v.option2, v.option3].map(val).filter((x) => x && !isDefault(x));
        if (!parts.length) return;
        parts.forEach((p, i) => { if (perIndex[i] && perIndex[i].indexOf(p) < 0) perIndex[i].push(p); });
        addItem(
          parts.join('|'),
          money(v.price, true),
          v.inventory_quantity != null ? v.inventory_quantity : (v.available === false ? 0 : 10),
          v.featured_image || null
        );
      });
      if (R.items.length > 1) {
        setOptions(names, perIndex);
        return finish('shopify:analytics');
      }
      R.items = [];
    }
  } catch (e) { /* not Shopify */ }

  /* ---------------- 2. Shopify theme JSON (window.product etc.) ---- */
  const grab = (text, key) => {
    const at = text.search(new RegExp('["\']' + key + '["\']\\s*:'));
    if (at < 0) return null;
    const iArr = text.indexOf('[', at);
    const iObj = text.indexOf('{', at);
    if (iArr < 0 && iObj < 0) return null;
    const start = iArr < 0 ? iObj : iObj < 0 ? iArr : Math.min(iArr, iObj);
    if (start < 0) return null;
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (!depth) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  };

  const applyShopifyProduct = (prod, source) => {
    if (!prod || !Array.isArray(prod.variants) || prod.variants.length < 2) return null;
    const names = (prod.options || []).map((o) => val(o && typeof o === 'object' ? o.name || o.title : o)).filter(Boolean);
    const perIndex = names.map(() => []);
    R.items = [];
    prod.variants.forEach((v) => {
      const parts = [v.option1, v.option2, v.option3].map(val).filter((x) => x && !isDefault(x));
      if (!parts.length) return;
      parts.forEach((p, i) => { if (perIndex[i] && perIndex[i].indexOf(p) < 0) perIndex[i].push(p); });
      addItem(
        parts.join('|'),
        money(v.price, true),
        v.inventory_quantity != null ? v.inventory_quantity : (v.available === false ? 0 : 10),
        v.featured_image && typeof v.featured_image === 'object' ? v.featured_image.src : v.featured_image
      );
    });
    if (R.items.length < 2) { R.items = []; return null; }
    setOptions(names, perIndex);
    return finish(source);
  };

  try {
    if (window.product && window.product.variants) {
      const r = applyShopifyProduct(window.product, 'shopify:page-object');
      if (r) return r;
    }
  } catch (e) { /* ignore */ }

  /* ---------------- 3. Shopify inline JSON / product.js ------------ */
  try {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script#ProductJson-product-template, script[id^="ProductJson-"], script[data-product-json]'
    );
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.length < 20 || txt.length > 3000000 || txt.indexOf('"variants"') < 0) continue;
      try {
        const parsed = JSON.parse(txt);
        const prod = parsed && parsed.product ? parsed.product : parsed;
        const r = applyShopifyProduct(prod, 'shopify:inline-json');
        if (r) return r;
      } catch (e) { /* try next script */ }
    }
    // Theme scripts that are not marked as JSON: pull the variants array out.
    for (const s of document.querySelectorAll('script:not([src])')) {
      const txt = s.textContent || '';
      if (txt.length < 40 || txt.length > 400000) continue;
      if (txt.indexOf('"variants"') < 0 || txt.indexOf('option1') < 0) continue;
      const variants = grab(txt, 'variants');
      if (!Array.isArray(variants) || variants.length < 2) continue;
      const opts = grab(txt, 'options');
      const r = applyShopifyProduct({ variants: variants, options: Array.isArray(opts) ? opts : [] }, 'shopify:inline-script');
      if (r) return r;
    }
  } catch (e) { /* ignore */ }

  /* ---------------- 4. Shopify .js endpoint (MAIN world) ------------ */
  try {
    const looksShopify =
      !!window.Shopify ||
      !!document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"]');
    const m = location.pathname.match(/\/products\/([^/?#]+)/);
    if (looksShopify && m) {
      const res = await fetch(location.origin + '/products/' + m[1] + '.js', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const j = await res.json();
        const r = applyShopifyProduct(j, 'shopify:endpoint');
        if (r) return r;
      }
    }
  } catch (e) { /* blocked or not Shopify */ }

  /* ---------------- 5. WooCommerce variations JSON ---------------- */
  try {
    const form = document.querySelector('form.variations_form, .variations_form, form[data-product_variations]');
    if (form) {
      const raw = form.getAttribute('data-product_variations');
      const labels = Array.from(form.querySelectorAll('.variations th.label, .variations .label')).map((th) =>
        val(th.textContent).replace(/[:\s]+$/, '')
      );
      const selects = Array.from(form.querySelectorAll('select[name^="attribute_"]'));

      if (raw && raw !== 'false' && raw !== '[]') {
        const variations = JSON.parse(raw);
        const order = selects.length ? selects.map((s) => s.name) : Object.keys((variations[0] && variations[0].attributes) || {});
        const displayFor = (attrName, slug) => {
          const sel = form.querySelector('select[name="' + attrName + '"]');
          if (sel) {
            const opt = Array.from(sel.options).find(
              (o) => o.value === slug || val(o.text).toLowerCase() === val(slug).toLowerCase()
            );
            if (opt) return val(opt.text);
          }
          const radio = form.querySelector(
            'input[name="' + attrName + '"][value="' + String(slug).replace(/"/g, '\\"') + '"]'
          );
          if (radio) {
            const wrap = radio.closest('li, label, .value');
            const label = wrap && val(wrap.textContent);
            if (label) return label;
          }
          return val(slug).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        };

        const names = order.map((name, i) => labels[i] || val(name).replace(/^attribute_/, '').replace(/^pa_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
        const perIndex = names.map(() => []);
        R.items = [];
        variations.forEach((v) => {
          const attrs = v.attributes || {};
          const parts = order.map((name) => displayFor(name, attrs[name] || '')).filter(Boolean);
          if (parts.length !== order.length) return;
          parts.forEach((p, i) => { if (perIndex[i] && perIndex[i].indexOf(p) < 0) perIndex[i].push(p); });
          addItem(
            parts.join('|'),
            money(v.display_price != null ? v.display_price : v.price),
            v.is_in_stock === false ? 0 : v.max_qty != null ? v.max_qty : 10,
            v.image && (v.image.src || v.image.url)
          );
        });
        if (R.items.length > 1) {
          setOptions(names, perIndex);
          return finish('woocommerce:variations');
        }
        R.items = [];
      }

      // Variable product without the JSON payload (lazy themes): build the grid.
      if (selects.length) {
        const names = selects.map((s, i) => labels[i] || val(s.name).replace(/^attribute_/, '').replace(/^pa_/, '').replace(/_/g, ' '));
        const values = selects.map((s) =>
          Array.from(s.options).map((o) => val(o.text)).filter((t) => t && !/choose|select/i.test(t))
        );
        if (values.every((v) => v.length) && grid(names, values, pagePrice())) return finish('woocommerce:selects');
      }
    }
  } catch (e) { /* ignore */ }

  /* ---------------- 6. Amazon twister ---------------- */
  try {
    if (/(^|\.)amazon\./i.test(location.hostname)) {
      let display = null;
      let rawValues = null;
      for (const s of document.querySelectorAll('script:not([src])')) {
        const txt = s.textContent || '';
        if (txt.indexOf('dimensionValuesDisplayData') < 0 && txt.indexOf('asinVariationValues') < 0) continue;
        display = grab(txt, 'dimensionValuesDisplayData') || display;
        rawValues = grab(txt, 'dimensionValuesData') || rawValues;
        if (display) break;
      }

      if (display && typeof display === 'object') {
        const asins = Object.keys(display);
        const width = Array.isArray(display[asins[0]]) ? display[asins[0]].length : 0;
        if (width) {
          const labelEls = Array.from(
            document.querySelectorAll('#twister .a-form-label, #twister label.a-form-label, [id^="variation_"] .a-form-label')
          ).map((el) => val(el.textContent).replace(/[:\s]+$/, '')).filter(Boolean);
          const names = [];
          for (let i = 0; i < width; i++) names.push(labelEls[i] || 'Option ' + (i + 1));
          const perIndex = names.map(() => []);
          const base = pagePrice();
          asins.forEach((asin) => {
            const parts = (display[asin] || []).map(val).filter(Boolean);
            if (parts.length !== width) return;
            parts.forEach((p, i) => { if (perIndex[i] && perIndex[i].indexOf(p) < 0) perIndex[i].push(p); });
            addItem(parts.join('|'), base, 10, null);
          });
          if (R.items.length > 1) {
            setOptions(names, perIndex);
            return finish('amazon:twister');
          }
        }
      }

      // Fallback: read the dimension lists from the DOM.
      const groups = [];
      document.querySelectorAll('#twister .a-section, #twister [id^="variation_"]').forEach((sec) => {
        const id = val(sec.getAttribute('id'));
        if (!/^variation_/.test(id)) return;
        const label = val((sec.querySelector('.a-form-label, label') || {}).textContent).replace(/[:\s]+$/, '') || id.replace(/^variation_/, '').replace(/_name$/, '').replace(/_/g, ' ');
        const values = Array.from(sec.querySelectorAll('li[data-defaultasin], select option[value]'))
          .map((el) => (val(el.getAttribute('title')) || val(el.textContent)))
          .filter((t) => t && !/choose|select/i.test(t));
        if (values.length) groups.push({ name: label, values: values.filter((v, i, a) => a.indexOf(v) === i) });
      });
      if (groups.length && groups.every((g) => g.values.length > 1)) {
        const built = grid(groups.map((g) => g.name), groups.map((g) => g.values), pagePrice());
        if (built) return finish('amazon:dom');
      }
    }
  } catch (e) { /* ignore */ }

  /* ---------------- 7. JSON-LD hasVariant / offers --------------- */
  try {
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      if (R.items.length > 1) return;
      let parsed;
      try { parsed = JSON.parse(s.textContent); } catch (e) { return; }
      const nodes = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      nodes.forEach((node) => {
        if (!node) return;
        const variants = [].concat(node.hasVariant || []);
        const offers = [].concat(node.offers || []);
        const list = variants.length > 1 ? variants : offers.length > 1 ? offers : [];
        if (list.length < 2) return;
        const names = [];
        const perIndex = [];
        R.items = [];
        list.forEach((v) => {
          const parts = [v.name, v.color, v.size, v.sku].map(val).filter((x) => x && !isDefault(x));
          const key = parts.length ? parts.slice(0, 2).join('|') : val(v.name || v.sku);
          if (!key) return;
          const price = v.offers ? [].concat(v.offers)[0] : v;
          addItem(key, money(price && (price.price || price.lowPrice)), v.inventoryLevel != null ? v.inventoryLevel : 10, v.image);
        });
        if (R.items.length > 1) {
          const width = R.items[0].key.split('|').length;
          for (let i = 0; i < width; i++) { names.push('Option ' + (i + 1)); perIndex.push([]); }
          R.items.forEach((it) => it.key.split('|').forEach((p, i) => { if (perIndex[i] && perIndex[i].indexOf(p) < 0) perIndex[i].push(p); }));
          setOptions(names, perIndex);
        }
      });
    });
    if (R.items.length > 1) return finish('json-ld');
  } catch (e) { /* ignore */ }

  /* ---------------- 8. Generic attribute selects ---------------- */
  try {
    const selects = Array.from(document.querySelectorAll('form select[name^="attribute_"], form select[id^="attribute_"]'));
    if (selects.length) {
      const names = selects.map((s) => val(s.getAttribute('aria-label') || s.name).replace(/^attribute_/, '').replace(/^pa_/, '').replace(/_/g, ' '));
      const values = selects.map((s) => Array.from(s.options).map((o) => val(o.text)).filter((t) => t && !/choose|select/i.test(t)));
      if (values.every((v) => v.length) && grid(names, values, pagePrice())) return finish('generic:selects');
    }
  } catch (e) { /* ignore */ }

  return finish('none');

  /* Build a full cartesian grid (capped) from option names + values. */
  function grid(names, values, price) {
    let combos = [[]];
    for (let i = 0; i < names.length && i < 3; i++) {
      const next = [];
      combos.forEach((c) => values[i].forEach((v) => { if (next.length < 150) next.push(c.concat([v])); }));
      combos = next;
    }
    R.items = [];
    R.options = [];
    const perIndex = names.map(() => []);
    combos.forEach((c) => {
      c.forEach((v, i) => { if (perIndex[i] && perIndex[i].indexOf(v) < 0) perIndex[i].push(v); });
      addItem(c.join('|'), price, 10, null);
    });
    setOptions(names, perIndex);
    return R.items.length > 1;
  }
}
