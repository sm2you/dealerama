/**
 * Exercises the real extension/extractVariants() against three page shapes.
 *
 *   node test/variants.test.mjs
 *
 * This is the regression test for "variants: none": the old code read
 * window.ShopifyAnalytics from the isolated world, where that global does not
 * exist. Here the function runs with the page global present (MAIN world) and
 * the resulting keys are asserted to be pipe-separated, because that is what
 * admin.html and product.html compare against.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../extension/popup.js', import.meta.url)), 'utf8');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    failures.push({ name, error: e });
    console.log('FAIL  ' + name + '\n      ' + (e && e.message));
  }
}

/** A tiny DOM where each selector is looked up verbatim. */
function makeDocument(map = {}) {
  const stubEl = () => ({
    textContent: '',
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    getAttribute: () => null
  });
  return {
    title: 'Test page',
    documentElement: { className: '' },
    images: [],
    getElementById: () => stubEl(),
    querySelector: (sel) => (Object.prototype.hasOwnProperty.call(map, sel) ? map[sel] : null),
    querySelectorAll: (sel) => {
      if (!Object.prototype.hasOwnProperty.call(map, sel)) return [];
      const v = map[sel];
      return Array.isArray(v) ? v : [v];
    }
  };
}

function loadExtractor({ dom = {}, globals = {}, location = {} } = {}) {
  const ctx = vm.createContext({
    console,
    URL,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
  });
  vm.runInContext('globalThis.window = globalThis;', ctx);
  ctx.document = makeDocument(dom);
  ctx.location = Object.assign(
    {
      href: 'https://shop.example.com/products/test-tee',
      origin: 'https://shop.example.com',
      pathname: '/products/test-tee',
      hostname: 'shop.example.com',
      search: ''
    },
    location
  );
  Object.assign(ctx, globals);
  vm.runInContext(source, ctx, { filename: 'popup.js' });
  return ctx;
}

const labels = (...texts) => texts.map((t) => ({ textContent: t }));
const select = (name, pairs) => ({ name, options: pairs.map(([value, text]) => ({ value, text })) });

/* ================================================================== *
 * Shopify — the case that used to fail in the isolated world
 * ================================================================== */
await test('Shopify variants come from window.ShopifyAnalytics (MAIN world)', async () => {
  const ctx = loadExtractor({
    globals: {
      ShopifyAnalytics: {
        meta: {
          product: {
            options: [
              { name: 'Color', values: ['Red', 'Blue'] },
              { name: 'Size', values: ['S', 'M'] }
            ],
            variants: [
              { option1: 'Red', option2: 'S', price: 2150, inventory_quantity: 4, featured_image: '//cdn.shopify.com/s/files/1/red_800x.jpg?v=1' },
              { option1: 'Red', option2: 'M', price: 2150, inventory_quantity: 0, featured_image: null },
              { option1: 'Blue', option2: 'S', price: 2250, inventory_quantity: 6, featured_image: '//cdn.shopify.com/s/files/1/blue_800x.jpg' },
              { option1: 'Blue', option2: 'M', price: 2250, inventory_quantity: -2, featured_image: null }
            ]
          }
        }
      }
    }
  });

  const res = await ctx.extractVariants();
  assert.ok(res, 'variants must not be null');

  assert.equal(res.source, 'shopify:analytics');
  assert.deepEqual(JSON.parse(JSON.stringify(res.options)), [
    { name: 'Color', values: ['Red', 'Blue'] },
    { name: 'Size', values: ['S', 'M'] }
  ]);

  const items = JSON.parse(JSON.stringify(res.items));
  assert.deepEqual(items.map((i) => i.key), ['Red|S', 'Red|M', 'Blue|S', 'Blue|M'], 'keys must be pipe separated');
  assert.equal(items[0].price, 21.5, 'Shopify prices are cents');
  assert.equal(items[0].qty, 4);
  assert.equal(items[1].qty, 0, 'sold-out variants keep 0');
  assert.equal(items[0].image, 'https://cdn.shopify.com/s/files/1/red.jpg?v=1', 'Shopify size modifier stripped');
  assert.equal(items[3].qty, 0, 'negative inventory clamps to 0');
});

await test('Shopify "Default Title" single-variant products are not treated as variants', async () => {
  const ctx = loadExtractor({
    globals: {
      ShopifyAnalytics: {
        meta: {
          product: {
            options: [{ name: 'Title', values: ['Default Title'] }],
            variants: [{ option1: 'Default Title', price: 1000, inventory_quantity: 3 }]
          }
        }
      }
    }
  });
  assert.equal(await ctx.extractVariants(), null);
});

/* ================================================================== *
 * WooCommerce
 * ================================================================== */
await test('WooCommerce variations use display labels, prices and stock', async () => {
  const variations = [
    {
      attributes: { attribute_pa_color: 'red', attribute_pa_size: 'm' },
      display_price: 21.5,
      max_qty: 3,
      is_in_stock: true,
      image: { src: 'https://shop.example.com/wp-content/uploads/red_400x400.jpg' }
    },
    {
      attributes: { attribute_pa_color: 'blue', attribute_pa_size: 's' },
      display_price: 22,
      max_qty: 0,
      is_in_stock: false,
      image: null
    }
  ];

  const colorSelect = select('attribute_pa_color', [
    ['', 'Choose an option'],
    ['red', 'Red'],
    ['blue', 'Blue']
  ]);
  const sizeSelect = select('attribute_pa_size', [
    ['', 'Choose an option'],
    ['s', 'S'],
    ['m', 'M']
  ]);

  const form = {
    getAttribute: (name) => (name === 'data-product_variations' ? JSON.stringify(variations) : null),
    querySelectorAll: (sel) => {
      if (sel.indexOf('th.label') >= 0) return labels('Color:', 'Size:');
      if (sel.indexOf('select[name^="attribute_"]') >= 0) return [colorSelect, sizeSelect];
      return [];
    },
    querySelector: (sel) => {
      const m = sel.match(/select\[name="([^"]+)"\]/);
      if (!m) return null;
      return [colorSelect, sizeSelect].find((s) => s.name === m[1]) || null;
    }
  };

  const ctx = loadExtractor({
    dom: {
      'form.variations_form, .variations_form, form[data-product_variations]': form
    }
  });

  const res = await ctx.extractVariants();
  assert.ok(res, 'variants must not be null');
  assert.equal(res.source, 'woocommerce:variations');

  const items = JSON.parse(JSON.stringify(res.items));
  assert.deepEqual(items.map((i) => i.key), ['Red|M', 'Blue|S'], 'slugs must become display labels');
  assert.equal(items[0].price, 21.5, 'Woo display_price is already dollars');
  assert.equal(items[0].qty, 3);
  // A WordPress filename may legitimately contain "_400x400"; it must not be rewritten.
  assert.equal(items[0].image, 'https://shop.example.com/wp-content/uploads/red_400x400.jpg');
  assert.equal(items[1].qty, 0, 'out-of-stock variation gets 0');

  assert.deepEqual(JSON.parse(JSON.stringify(res.options)), [
    { name: 'Color', values: ['Red', 'Blue'] },
    { name: 'Size', values: ['M', 'S'] }
  ]);
});

/* ================================================================== *
 * Amazon
 * ================================================================== */
await test('Amazon twister dimensionValuesDisplayData becomes pipe keys', async () => {
  const twisterScript = {
    textContent:
      'var dataToReturn = {"dimensionValuesDisplayData":{"B001":["Red","M"],"B002":["Blue","S"]},' +
      '"dimensionValuesData":{"B001":["red","m"],"B002":["blue","s"]},"dimensions":["color_name","size_name"]};'
  };

  const price = {
    textContent: '$29.99',
    getAttribute: () => null
  };

  const ctx = loadExtractor({
    location: {
      href: 'https://www.amazon.ca/dp/B001',
      origin: 'https://www.amazon.ca',
      pathname: '/dp/B001',
      hostname: 'www.amazon.ca'
    },
    dom: {
      'script:not([src])': [twisterScript],
      '#twister .a-form-label, #twister label.a-form-label, [id^="variation_"] .a-form-label': labels('Color', 'Size'),
      '#corePrice_feature_div .a-offscreen, span.a-price .a-offscreen, #priceblock_ourprice, .price .amount, .woocommerce-Price-amount, [itemprop="price"]': price
    }
  });

  const res = await ctx.extractVariants();
  assert.ok(res, 'variants must not be null');
  assert.equal(res.source, 'amazon:twister');

  const items = JSON.parse(JSON.stringify(res.items));
  assert.deepEqual(items.map((i) => i.key), ['Red|M', 'Blue|S']);
  assert.equal(items[0].price, 29.99);
  assert.equal(items[0].qty, 10);

  assert.deepEqual(JSON.parse(JSON.stringify(res.options)), [
    { name: 'Color', values: ['Red', 'Blue'] },
    { name: 'Size', values: ['M', 'S'] }
  ]);
});

/* ================================================================== *
 * Nothing to find
 * ================================================================== */
await test('a page with no options returns null instead of an empty variant set', async () => {
  const ctx = loadExtractor();
  assert.equal(await ctx.extractVariants(), null);
});

/* ================================================================== *
 * Merging MAIN + isolated results
 * ================================================================== */
await test('pickVariants prefers the richer result and rejects single items', () => {
  const ctx = loadExtractor();

  const main = {
    source: 'shopify:analytics',
    options: [{ name: 'Color', values: ['Red'] }],
    items: [{ key: 'Red', price: 10, qty: 1, sold: 0, image: null }]
  };
  const isolated = {
    source: 'json-ld',
    options: [{ name: 'Color', values: ['Red', 'Blue'] }],
    items: [
      { key: 'Red', price: 10, qty: 1, sold: 0, image: null },
      { key: 'Blue', price: 12, qty: 2, sold: 0, image: 'https://cdn.shopify.com/x.jpg' }
    ]
  };

  const merged = JSON.parse(JSON.stringify(ctx.pickVariants(main, isolated)));
  assert.equal(merged.items.length, 2);
  assert.equal(merged.source, 'json-ld');
  assert.equal(merged.items[1].price, 12);

  assert.equal(ctx.pickVariants(main, null), null, 'one variant is not a variant set');
  assert.equal(ctx.pickVariants(null, null), null);
});

await test('pickVariants de-duplicates and caps keys', () => {
  const ctx = loadExtractor();
  const result = ctx.pickVariants(
    null,
    {
      source: 'woocommerce:variations',
      options: [{ name: 'Size', values: ['S', 'M'] }],
      items: [
        { key: 'S', price: 10, qty: 1, sold: 0 },
        { key: 'S', price: 10, qty: 1, sold: 0 },
        { key: 'M', price: '', qty: 0, sold: 0 }
      ]
    }
  );
  const items = JSON.parse(JSON.stringify(result.items));
  assert.deepEqual(items.map((i) => i.key), ['S', 'M']);
  assert.equal(items[1].price, null, 'an empty variant price falls back to the base price');
});

/* ================================================================== *
 * JSON-LD hasVariant (Costco-style) — the case from the screenshot
 * ================================================================== */
const TITLE = "Caterpillar Men's Cotton-Blend Fulton Hoodie";

await test('JSON-LD variants with only a name are split into Color/Size, never SKUs', async () => {
  const jsonld = {
    '@type': 'Product',
    name: TITLE,
    hasVariant: [
      { '@type': 'Product', name: TITLE + ', Black, Small', sku: '2061919', offers: { '@type': 'Offer', price: '31.99' } },
      { '@type': 'Product', name: TITLE + ', Navy, Medium', sku: '2061920', offers: { '@type': 'Offer', price: '31.99' } },
      { '@type': 'Product', name: TITLE + ', Green, Large', sku: '2061921', offers: { '@type': 'Offer', price: '32.99' } }
    ]
  };
  const script = { textContent: JSON.stringify(jsonld) };
  const ctx = loadExtractor({
    dom: { 'script[type="application/ld+json"]': [script] }
  });

  const res = await ctx.extractVariants();
  assert.ok(res, 'variants must be found');
  assert.equal(res.source, 'json-ld');

  const options = JSON.parse(JSON.stringify(res.options));
  assert.deepEqual(options.map((o) => o.name), ['Color', 'Size'], 'option names come from the values, not "Option 1"');
  assert.deepEqual(options[0].values, ['Black', 'Navy', 'Green']);
  assert.deepEqual(options[1].values, ['Small', 'Medium', 'Large']);

  const items = JSON.parse(JSON.stringify(res.items));
  assert.deepEqual(items.map((i) => i.key), ['Black|Small', 'Navy|Medium', 'Green|Large']);
  assert.equal(items[0].price, 31.99);
  assert.equal(items[2].price, 32.99);
  assert.ok(!JSON.stringify(res).includes('2061919'), 'SKUs must never become option values');
  assert.ok(!items.some((i) => i.key.includes('Caterpillar')), 'the product title must never become an option value');
});

await test('JSON-LD variants prefer explicit color/size fields', async () => {
  const jsonld = {
    '@type': 'Product',
    name: TITLE,
    hasVariant: [
      { '@type': 'Product', name: TITLE, color: 'Black', size: 'S', sku: '111', offers: { price: '31.99' } },
      { '@type': 'Product', name: TITLE, color: 'Bronze', size: 'XL', sku: '222', offers: { price: '33.5' } }
    ]
  };
  const ctx = loadExtractor({
    dom: { 'script[type="application/ld+json"]': [{ textContent: JSON.stringify(jsonld) }] }
  });

  const res = await ctx.extractVariants();
  assert.ok(res);
  const options = JSON.parse(JSON.stringify(res.options));
  assert.deepEqual(options.map((o) => o.name), ['Color', 'Size']);
  assert.deepEqual(options[0].values, ['Black', 'Bronze']);
  assert.deepEqual(JSON.parse(JSON.stringify(res.items)).map((i) => i.key), ['Black|S', 'Bronze|XL']);
});

await test('JSON-LD variant values that are long sentences are rejected', async () => {
  const jsonld = {
    '@type': 'Product',
    name: 'Widget',
    hasVariant: [
      { name: 'Widget, This is a very long marketing sentence that should never be an option value', offers: { price: 9.99 } },
      { name: 'Widget, Another extremely long blurb that is clearly not a size or a colour', offers: { price: 9.99 } }
    ]
  };
  const ctx = loadExtractor({
    dom: { 'script[type="application/ld+json"]': [{ textContent: JSON.stringify(jsonld) }] }
  });
  const res = await ctx.extractVariants();
  assert.equal(res, null, 'no usable variant dimensions should mean "no variants", not garbage rows');
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
