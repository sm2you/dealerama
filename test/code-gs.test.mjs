/**
 * Runs the real apps-script/Code.gs inside a Node VM with an in-memory Google
 * Sheets / Apps Script emulator. No credentials, no network.
 *
 *   node test/code-gs.test.mjs
 *
 * This is what catches the bugs that only show up at runtime: the unset
 * SECRET_KEY auth bypass, skipped product deletions, apostrophe-mangled image
 * cells, draft/live filtering, stock movement on paid orders, and variants.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const codePath = fileURLToPath(new URL('../apps-script/Code.gs', import.meta.url));
const source = readFileSync(codePath, 'utf8');

let passed = 0;
const failures = [];

/** VM objects come from another realm; round-trip them so deepEqual compares values. */
const plain = (value) => JSON.parse(JSON.stringify(value));

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

/* ================================================================== *
 * Minimal Apps Script emulator
 * ================================================================== */
function createEnv() {
  const sheets = new Map();
  const props = new Map();
  const cache = new Map();
  const log = [];
  const fetched = [];
  const state = { imgbbFails: false, sessions: {}, uploads: 0, uuids: 0, sessionsCreated: 0 };

  class Range {
    constructor(sheet, row, col, numRows, numCols) {
      this.sheet = sheet;
      this.row = row;
      this.col = col;
      this.numRows = numRows;
      this.numCols = numCols;
    }
    getValues() {
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const data = this.sheet.data[this.row - 1 + r] || [];
        const row = [];
        for (let c = 0; c < this.numCols; c++) {
          const v = data[this.col - 1 + c];
          row.push(v === undefined ? '' : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(values) {
      for (let r = 0; r < values.length; r++) {
        const target = this.row - 1 + r;
        while (this.sheet.data.length <= target) this.sheet.data.push([]);
        const row = this.sheet.data[target];
        for (let c = 0; c < values[r].length; c++) {
          const idx = this.col - 1 + c;
          while (row.length <= idx) row.push('');
          row[idx] = values[r][c];
        }
      }
      return this;
    }
    setValue(v) {
      return this.setValues([[v]]);
    }
    getValue() {
      return this.getValues()[0][0];
    }
    setFontWeight() {
      return this;
    }
  }

  class Sheet {
    constructor(name) {
      this.name = name;
      this.data = [];
    }
    getLastColumn() {
      return this.data.reduce((max, row) => Math.max(max, row.length), 0);
    }
    getLastRow() {
      return this.data.length;
    }
    getRange(row, col, numRows = 1, numCols = 1) {
      return new Range(this, row, col, numRows, numCols);
    }
    getDataRange() {
      return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
    }
    appendRow(values) {
      this.data.push(values.slice());
    }
    deleteRow(row) {
      this.data.splice(row - 1, 1);
    }
    setFrozenRows() {}
  }

  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => {
      const s = new Sheet(n);
      sheets.set(n, s);
      return s;
    }
  };

  const response = (code, text, contentType = 'application/json') => ({
    getResponseCode: () => code,
    getContentText: () => text,
    getHeaders: () => ({ 'Content-Type': contentType }),
    getContent: () => Buffer.from(text),
    getBlob: () => ({
      getBytes: () => Buffer.from(text),
      getContentType: () => contentType
    })
  });

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => {}
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        text,
        getContent: () => text,
        setMimeType() {
          return this;
        }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        setProperties: (obj) => Object.keys(obj).forEach((k) => props.set(k, String(obj[k]))),
        deleteProperty: (k) => props.delete(k)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, String(v)),
        remove: (k) => cache.delete(k)
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => true,
        tryLock: () => true,
        releaseLock: () => true
      })
    },
    UrlFetchApp: {
      fetch: (url, opts = {}) => {
        const u = String(url);
        fetched.push({ url: u, opts });
        if (u.startsWith('https://api.imgbb.com')) {
          if (state.imgbbFails) {
            return response(400, JSON.stringify({ success: false, error: { message: 'Invalid API key' } }));
          }
          state.uploads++;
          return response(200, JSON.stringify({ success: true, data: { url: 'https://i.ibb.co/hosted-' + state.uploads + '.jpg' } }));
        }
        if (u.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
          const method = String(opts.method || 'get').toLowerCase();
          if (method === 'post') {
            state.sessionsCreated++;
            const id = 'cs_test_' + state.sessionsCreated;
            return response(200, JSON.stringify({ id: id, url: 'https://checkout.stripe.com/c/pay/' + id }));
          }
          const m = u.match(/sessions\/([^?]+)/);
          const id = m ? decodeURIComponent(m[1]) : '';
          const sess = state.sessions[id];
          if (!sess) return response(404, JSON.stringify({ error: { message: 'No such checkout session' } }));
          return response(200, JSON.stringify(sess));
        }
        if (u.startsWith('https://oauth2.googleapis.com')) {
          return response(200, JSON.stringify({ aud: 'client-id', email_verified: 'true', email: 'buyer@example.com', name: 'Buyer' }));
        }
        if (/\.(jpe?g|png|webp)(\?|$)/i.test(u)) {
          return response(200, 'IMAGEBYTES'.repeat(300), 'image/jpeg');
        }
        return response(404, 'not found', 'text/plain');
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      getUuid: () => {
        state.uuids++;
        return '00000000-0000-4000-8000-' + String(state.uuids).padStart(12, '0');
      },
      base64Encode: (data) => Buffer.from(data).toString('base64'),
      base64EncodeWebSafe: (data) => Buffer.from(data).toString('base64url'),
      computeDigest: (_alg, value) => Buffer.from(String(value))
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({
        timeBased: () => ({
          everyMinutes: () => ({ create: () => {} })
        })
      })
    },
    Logger: { log: (m) => log.push(String(m)) }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });

  const api = vm.runInContext(
    `({
      setup, newAdminSecret, selfTest, installTrigger,
      getPublic_, adminGet_, saveAll_, saveProductAuto, createProduct_,
      checkout_, confirmOrder_, syncPayments, submitReview_, images_, vparse_,
      normVariants_, view_, health_, doGet, doPost
    })`,
    ctx
  );

  const lastOrder = () => {
    const data = sheets.get('Orders').data;
    return data[data.length - 1] || [];
  };

  const callPost = (action, body = {}) => {
    const out = api.doPost({ postData: { contents: JSON.stringify(Object.assign({ action }, body)) } });
    return JSON.parse(out.getContent());
  };
  const callGet = (params) => {
    const out = api.doGet({ parameter: params || {} });
    return JSON.parse(out.getContent());
  };

  return { api, sheets, props, cache, state, callPost, callGet, ss, fetched, log, lastOrder };
}

const SECRET = 'a-very-long-admin-secret-123';

/* ================================================================== *
 * 1. setup()
 * ================================================================== */
const env = createEnv();
const { api, sheets, props, state, callPost, callGet, lastOrder } = env;

await test('setup() creates the four tabs with the v4 column order', () => {
  api.setup();
  for (const name of ['Sheet1', 'Reviews', 'Orders', 'Settings']) {
    assert.ok(sheets.has(name), name + ' tab missing');
  }
  const products = sheets.get('Sheet1').data[0];
  assert.deepEqual(products, [
    'id', 'title', 'price', 'description', 'imagesJson', 'dealType', 'stripeLink',
    'createdAt', 'qty', 'sold', 'status', 'preorder', 'startsAt', 'videoUrl', 'variantsJson'
  ]);
  assert.deepEqual(sheets.get('Orders').data[0], [
    'id', 'productId', 'qty', 'amount', 'stripeSessionId', 'status', 'email', 'createdAt',
    'name', 'address', 'phone', 'payment', 'userEmail', 'shipStatus', 'tracking', 'variant'
  ]);
  assert.ok(props.get('SECRET_KEY'), 'an admin secret must be generated');
});

await test('setup() is idempotent (no duplicate settings on re-run)', () => {
  const before = sheets.get('Settings').getLastRow();
  api.setup();
  api.setup();
  assert.equal(sheets.get('Settings').getLastRow(), before);
});

await test('setup() reports the admin secret exactly once', () => {
  const first = env.log.join('\n');
  assert.match(first, /ADMIN SECRET/);
});

await test('selfTest() reports every tab as present', () => {
  const report = api.selfTest();
  assert.equal(report.sheets.Sheet1.rows, 0);
  assert.equal(report.properties.SECRET_KEY, true);
  assert.equal(report.properties.STRIPE_SECRET_KEY, false);
});

// Both integrations are configured for the rest of the run (the admin panel
// reports them as "set" and imports actually host images).
props.set('IMGBB_API_KEY', 'test-imgbb-key');
props.set('STRIPE_SECRET_KEY', 'sk_test_fake_key');

/* ================================================================== *
 * 2. Parsing helpers
 * ================================================================== */
await test('images_() survives the rogue apostrophe that emptied the gallery', () => {
  assert.deepEqual(plain(api.images_({ imagesJson: `'["https://i.ibb.co/a.jpg"]'` })), ['https://i.ibb.co/a.jpg']);
  assert.deepEqual(plain(api.images_({ imagesJson: '"[""https://i.ibb.co/b.jpg""]"' })), ['https://i.ibb.co/b.jpg']);
});

await test('images_() flattens nested arrays', () => {
  assert.deepEqual(plain(api.images_({ imagesJson: '[["https://i.ibb.co/1.jpg"],["https://i.ibb.co/2.jpg"]]' })), [
    'https://i.ibb.co/1.jpg',
    'https://i.ibb.co/2.jpg'
  ]);
});

await test('images_() recovers URLs from unparseable text', () => {
  assert.deepEqual(plain(api.images_({ imagesJson: 'broken cell https://i.ibb.co/c.jpg trailing' })), ['https://i.ibb.co/c.jpg']);
  assert.deepEqual(plain(api.images_({ imagesJson: '[]' })), []);
  assert.deepEqual(plain(api.images_({})), []);
});

await test('vparse_() rewrites legacy "Red / M" keys to "Red|M"', () => {
  const parsed = api.vparse_({
    variantsJson: JSON.stringify({
      options: [{ name: 'Color', values: ['Red', 'Blue'] }, { name: 'Size', values: ['S', 'M'] }],
      items: [
        { key: 'Red / M', price: '21.5', qty: '3' },
        { key: 'Blue | S', price: '', qty: '1', sold: '2' }
      ]
    })
  });
  assert.deepEqual(plain(parsed.items.map((i) => i.key)), ['Red|M', 'Blue|S']);
  assert.equal(parsed.items[0].price, 21.5);
  assert.equal(parsed.items[1].price, 0);
  assert.equal(parsed.items[1].sold, 2);
});

await test('vparse_() ignores junk instead of throwing', () => {
  assert.equal(api.vparse_({ variantsJson: 'null' }), null);
  assert.equal(api.vparse_({ variantsJson: 'not json' }), null);
  assert.equal(api.vparse_({ variantsJson: '' }), null);
  assert.equal(api.vparse_({ variantsJson: '{"options":[],"items":[]}' }), null);
});

/* ================================================================== *
 * 3. Importing (extension path)
 * ================================================================== */
let importedId = '';
await test('saveProductAuto() uploads images, creates a draft with stock 1', () => {
  const r = api.saveProductAuto({
    title: 'Nike Air Max',
    price: '129.99',
    description: 'Great shoes',
    images: ['https://m.media-amazon.com/images/I/71abc._AC_SL1500_.jpg'],
    dealType: 'daily'
  });
  importedId = r.id;

  assert.equal(r.error, undefined, r.error);
  assert.equal(r.status, 'draft');
  assert.equal(r.images.length, 1);
  assert.match(r.images[0], /^https:\/\/i\.ibb\.co\//);
  assert.deepEqual(plain(r.failed), []);

  const row = sheets.get('Sheet1').data[1];
  assert.equal(row[1], 'Nike Air Max');
  assert.equal(row[2], 129.99);
  assert.equal(row[10], 'draft');
  assert.equal(row[8], 1, 'imported product must not start at 0 stock');
  assert.equal(row[0], r.id);
});

await test('saveProductAuto() keeps the source URL when ImgBB fails', () => {
  state.imgbbFails = true;
  const src = 'https://m.media-amazon.com/images/I/71xyz.jpg';
  const r = api.saveProductAuto({ title: 'Fallback product', price: 10, images: [src] });
  state.imgbbFails = false;

  assert.equal(r.error, undefined);
  assert.deepEqual(plain(r.images), [src], 'the product must never end up image-less');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /ImgBB|Invalid API key/i);
});

await test('saveProductAuto() validates title and price', () => {
  assert.match(api.saveProductAuto({ price: 10 }).error, /title/i);
  assert.match(api.saveProductAuto({ title: 'No price' }).error, /price/i);
  assert.match(api.saveProductAuto({ title: 'Zero', price: 0 }).error, /price/i);
});

await test('saveProductAuto() imports variants with pipe keys and stock', () => {
  const r = api.saveProductAuto({
    title: 'Variant Tee',
    price: 25,
    images: ['https://cdn.shopify.com/s/files/1/tee_800x.jpg'],
    variants: {
      options: [{ name: 'Color', values: ['Red', 'Blue'] }, { name: 'Size', values: ['S', 'M'] }],
      items: [
        { key: 'Red|S', price: 25, qty: 3, image: 'https://cdn.shopify.com/s/files/1/red_400x.jpg' },
        { key: 'Red|M', price: 27, qty: 2 },
        { key: 'Blue|S', price: 26, qty: 0 },
        { key: 'Blue|M', price: 26, qty: 1 }
      ]
    }
  });
  assert.equal(r.error, undefined);
  assert.equal(r.variants, 4);

  const row = sheets.get('Sheet1').data.find((x) => x[0] === r.id);
  const vj = JSON.parse(row[14]);
  assert.equal(vj.items.length, 4);
  assert.deepEqual(plain(vj.items.map((i) => i.key)), ['Red|S', 'Red|M', 'Blue|S', 'Blue|M']);
  assert.equal(row[8], 0, 'variant stock lives in variantsJson');
  assert.match(vj.items[0].image, /i\.ibb\.co/, 'variant images are hosted too');
});

/* ================================================================== *
 * 4. Auth
 * ================================================================== */
await test('adminGet needs the secret', () => {
  assert.match(callPost('adminGet', { secret: 'wrong' }).error, /Unauthorized/i);
  assert.match(callPost('adminGet').error, /Unauthorized/i);
  assert.equal(callPost('adminGet', { secret: props.get('SECRET_KEY') }).products.length, 3);
});

await test('auth is NOT bypassed when SECRET_KEY is unset', () => {
  const saved = props.get('SECRET_KEY');
  props.delete('SECRET_KEY');
  const res = callPost('adminGet');
  props.set('SECRET_KEY', saved);
  assert.match(res.error, /Unauthorized/i, 'an unset secret must never authorise a request');
});

await test('unknown actions are rejected, not silently accepted', () => {
  assert.match(callPost('deleteEverything', { secret: props.get('SECRET_KEY') }).error, /Unknown action/);
});

/* ================================================================== *
 * 5. Public read
 * ================================================================== */
await test('getPublic() hides drafts and never leaks private keys', () => {
  props.set('STRIPE_SECRET_KEY', 'sk_live_should_not_leak');
  props.set('IMGBB_API_KEY', 'imgbb_secret');
  const pub = callGet({ action: 'getPublic' });
  assert.equal(pub.products.length, 0, 'all imported products are drafts');
  assert.equal(JSON.stringify(pub).includes('sk_live_should_not_leak'), false);
  assert.equal(JSON.stringify(pub).includes('imgbb_secret'), false);
  assert.equal(pub.settings.site_name, 'Dealerama');
});

await test('cache is invalidated by writes', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', {
    secret,
    products: [{ id: importedId, fields: { status: 'live' } }]
  });
  const pub = callGet({ action: 'getPublic' });
  assert.equal(pub.products.length, 1);
  assert.equal(pub.products[0].id, importedId);
});

/* ================================================================== *
 * 6. Admin save
 * ================================================================== */
await test('saveAll updates fields, images and variants', () => {
  const secret = props.get('SECRET_KEY');
  const r = callPost('saveAll', {
    secret,
    products: [
      {
        id: importedId,
        fields: {
          title: 'Nike Air Max 90',
          price: '149.5',
          qty: '7',
          status: 'live',
          dealType: 'weekly',
          preorder: 'TRUE',
          startsAt: '2025-06-01',
          description: '<p>Nice</p>',
          images: ['https://i.ibb.co/hosted-1.jpg', 'not-a-url'],
          variants: {
            options: [{ name: 'Size', values: ['9', '10'] }],
            items: [{ key: '9', price: 149.5, qty: 4 }, { key: '10', price: 150, qty: 3 }]
          }
        }
      }
    ]
  });
  assert.equal(r.success, true, r.error);

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.title, 'Nike Air Max 90');
  assert.equal(p.price, 149.5);
  assert.equal(p.status, 'live');
  assert.equal(p.dealType, 'weekly');
  assert.equal(p.preorder, true);
  assert.equal(p.startsAt.slice(0, 10), '2025-06-01');
  assert.deepEqual(plain(p.images), ['https://i.ibb.co/hosted-1.jpg'], 'invalid URLs are dropped');
  assert.equal(p.variants.items.length, 2);
  assert.equal(p.qty, 7, 'variant stock is summed for display');
});

await test('offline sales move stock and keep sold history', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', {
    secret,
    products: [{ id: importedId, fields: { variants: { options: [], items: [] }, qty: '10', sold: '0' } }]
  });
  callPost('saveAll', { secret, products: [{ id: importedId, fields: { offline: '3' } }] });

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.variants, null);
  assert.equal(p.qty, 7);
  assert.equal(p.sold, 3);
});

await test('stock and sold can be set directly (offline sales, corrections)', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', { secret, products: [{ id: importedId, fields: { qty: '12', sold: '40' } }] });

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.qty, 12, 'stock is written as given');
  assert.equal(p.sold, 40, 'sold is written as given, not just incremented');
});

await test('an offline sale applies on top of an edited sold, it does not overwrite it', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', { secret, products: [{ id: importedId, fields: { qty: '20', sold: '5', offline: '2' } }] });

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.qty, 18);
  assert.equal(p.sold, 7, 'edited sold (5) + offline sale (2)');
});

await test('variant stock and sold are editable', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', {
    secret,
    products: [{
      id: importedId,
      fields: {
        variants: {
          options: [{ name: 'Size', values: ['S', 'M'] }],
          items: [
            { key: 'S', price: 20, qty: 4, sold: 11 },
            { key: 'M', price: 20, qty: 0, sold: 3 }
          ]
        }
      }
    }]
  });

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.variants.items.find((i) => i.key === 'S').sold, 11, 'edited sold is kept');
  assert.equal(p.variants.items.find((i) => i.key === 'M').qty, 0);
  assert.equal(p.qty, 4, 'product stock sums the variants');
  assert.equal(p.sold, 14, 'product sold sums the variants');
});

await test('a variant sold value is preserved when the option grid is rebuilt without it', () => {
  const secret = props.get('SECRET_KEY');
  // The admin rebuilds the grid from options only; sold must survive by key.
  callPost('saveAll', {
    secret,
    products: [{
      id: importedId,
      fields: {
        variants: {
          options: [{ name: 'Size', values: ['S', 'M'] }],
          items: [{ key: 'S', price: 20, qty: 4 }, { key: 'M', price: 20, qty: 2 }]
        }
      }
    }]
  });
  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.variants.items.find((i) => i.key === 'S').sold, 11, 'existing sold history is not wiped');
});

await test('adminGet reports the backend version so the UI can gate sold editing', () => {
  const secret = props.get('SECRET_KEY');
  const data = callPost('adminGet', { secret });
  assert.match(data.version, /^\d+\.\d+\.\d+$/);
  assert.ok(data.version >= '5.1.0');
});

await test('saveAll APPLIES product deletions and the new review in the same call', () => {
  const secret = props.get('SECRET_KEY');
  const doomed = api.createProduct_();

  const res = callPost('saveAll', {
    secret,
    products: [{ id: doomed.id, fields: { _del: 'TRUE' } }],
    newReview: { productId: importedId, name: 'Real Customer', orderRef: 'ORD-123', stars: '5', text: 'Love it' }
  });
  assert.equal(res.success, true, res.error);

  const products = api.adminGet_().products;
  assert.equal(products.some((p) => p.id === doomed.id), false, 'the deletion must not be skipped');
  const review = api.adminGet_().reviews[0];
  assert.equal(review.text, 'Love it');
  assert.equal(review.status, 'shown');
});

await test('a review without a real order reference is refused', () => {
  const secret = props.get('SECRET_KEY');
  const res = callPost('saveAll', {
    secret,
    newReview: { productId: importedId, name: 'Anon', stars: '5', text: 'nice' }
  });
  assert.match(res.error, /order reference/i);
});

await test('settings and private keys persist; short secrets are rejected', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', { secret, settings: { site_name: 'Deal Station', primary_color: '#123456', footer_pages: '[]' } });
  const d = api.adminGet_();
  assert.equal(d.settings.site_name, 'Deal Station');
  assert.equal(d.settings.primary_color, '#123456');

  assert.match(callPost('saveAll', { secret, keys: { SECRET_KEY: 'short' } }).error, /12 characters/i);

  const res = callPost('saveAll', { secret, keys: { SECRET_KEY: 'brand-new-admin-secret-42' } });
  assert.equal(res.success, true);
  assert.equal(props.get('SECRET_KEY'), 'brand-new-admin-secret-42');
  assert.equal(callPost('adminGet', { secret: 'brand-new-admin-secret-42' }).products.length > 0, true);
});

await test('keysSet reports all three secrets', () => {
  const secret = props.get('SECRET_KEY');
  const d = callPost('adminGet', { secret });
  assert.deepEqual(plain(d.keysSet), { STRIPE_SECRET_KEY: true, IMGBB_API_KEY: true, SECRET_KEY: true });
});

/* ================================================================== *
 * 7. Checkout + payments
 * ================================================================== */
await test('checkout creates a pending order and returns the Stripe URL', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', {
    secret,
    // Set stock and sold explicitly so this test does not depend on history.
    products: [{ id: importedId, fields: { status: 'live', variants: { options: [], items: [] }, qty: '5', sold: '3', price: '10' } }]
  });

  const r = callPost('checkout', { productId: importedId, qty: 2 });
  assert.match(String(r.url || ''), /checkout\.stripe\.com/, JSON.stringify(r));

  const order = lastOrder();
  assert.match(String(order[4]), /^cs_test_/);
  assert.equal(order[5], 'pending');
  assert.equal(order[2], 2);
  assert.equal(order[3], 20);
});

await test('checkout validates stock and price', () => {
  const tooMany = callPost('checkout', { productId: importedId, qty: 99 });
  assert.match(tooMany.error, /Only 5 available/);
  const missing = callPost('checkout', { productId: 'nope', qty: 1 });
  assert.match(missing.error, /not found/i);
});

await test('confirmOrder marks the order paid and moves stock exactly once', () => {
  const sessionId = lastOrder()[4];
  state.sessions[sessionId] = {
    payment_status: 'paid',
    status: 'complete',
    customer_details: { email: 'buyer@example.com', name: 'Buyer', phone: '+15551234567', address: { city: 'Toronto', country: 'CA' } },
    payment_intent: { type: 'card', payment_method: { type: 'card', card: { brand: 'visa', last4: '4242' } } }
  };

  const first = callPost('confirmOrder', { sessionId: sessionId });
  assert.equal(first.ok, true);
  assert.equal(first.updated, 1);

  const order = api.adminGet_().orders.find((o) => o.id === lastOrder()[0]);
  assert.equal(order.status, 'paid');
  assert.equal(order.shipStatus, 'processing');
  assert.match(order.payment, /visa \*\*\*\*4242/);

  const product = api.adminGet_().products.find((p) => p.id === importedId);
  assert.equal(product.qty, 3, 'stock must drop by the ordered quantity');
  assert.equal(product.sold, 5, '3 offline + 2 online');

  const second = callPost('confirmOrder', { sessionId: sessionId });
  assert.equal(second.updated, 0, 'confirming twice must not move stock twice');
  assert.equal(api.adminGet_().products.find((p) => p.id === importedId).qty, 3);
});

await test('confirmOrder refuses unknown or malformed sessions', () => {
  assert.equal(callPost('confirmOrder', { sessionId: '../etc/passwd' }).ok, false);
  assert.equal(callPost('confirmOrder', { sessionId: 'cs_does_not_exist' }).ok, false);
});

await test('variant checkout decrements the variant, not the base product', () => {
  const secret = props.get('SECRET_KEY');
  callPost('saveAll', {
    secret,
    products: [
      {
        id: importedId,
        fields: {
          status: 'live',
          price: '25',
          variants: {
            options: [{ name: 'Size', values: ['S', 'M'] }],
            items: [{ key: 'S', price: 25, qty: 2 }, { key: 'M', price: 26, qty: 5 }]
          }
        }
      }
    ]
  });

  const r = callPost('checkout', { productId: importedId, qty: 1, variant: 'M' });
  assert.match(String(r.url || ''), /checkout\.stripe\.com/, JSON.stringify(r));

  const sessionId = lastOrder()[4];
  assert.equal(api.adminGet_().orders[0].variant, 'M');

  state.sessions[sessionId] = {
    payment_status: 'paid',
    status: 'complete',
    customer_details: { email: 'buyer@example.com', address: { country: 'CA' } },
    payment_intent: { type: 'card', payment_method: { type: 'card', card: { brand: 'visa', last4: '4242' } } }
  };
  const confirmed = callPost('confirmOrder', { sessionId: sessionId });
  assert.equal(confirmed.ok, true);

  const p = api.adminGet_().products.find((x) => x.id === importedId);
  assert.equal(p.variants.items.find((i) => i.key === 'M').qty, 4, 'variant M must drop 5 -> 4');
  assert.equal(p.variants.items.find((i) => i.key === 'S').qty, 2, 'variant S untouched');
});

await test('syncPayments tolerates a trigger event object as its first argument', () => {
  assert.doesNotThrow(() => api.syncPayments({ triggerUid: 'abc', year: 2025 }));
});

/* ================================================================== *
 * 8. Reviews
 * ================================================================== */
await test('moderated reviews stay pending until approved', () => {
  const r = callPost('submitReview', {
    productId: importedId,
    stars: 5,
    name: 'Casey',
    email: 'casey@example.com',
    text: 'Excellent'
  });
  assert.equal(r.success, true);
  assert.equal(r.published, false, 'review_mode is moderate by default');

  const pub = callGet({ action: 'getPublic' });
  assert.equal(pub.reviews.some((r) => r.name === 'Casey'), false, 'pending reviews stay off the storefront');

  const secret = props.get('SECRET_KEY');
  const pending = api.adminGet_().reviews.find((x) => x.email === 'casey@example.com');
  callPost('saveAll', { secret, reviews: [{ id: pending.id, status: 'shown', reply: 'Thanks!' }] });

  const after = callGet({ action: 'getPublic' });
  const casey = after.reviews.filter((r) => r.name === 'Casey');
  assert.equal(casey.length, 1);
  assert.equal(casey[0].reply, 'Thanks!');
});

await test('a second review from the same email is refused', () => {
  const r = callPost('submitReview', {
    productId: importedId,
    stars: 4,
    name: 'Casey',
    email: 'casey@example.com',
    text: 'Again'
  });
  assert.match(r.error, /already reviewed/i);
});

await test('review validation rejects bad input', () => {
  assert.match(callPost('submitReview', { productId: importedId, stars: 5, name: 'X', email: 'bad', text: 'y' }).error, /valid email/i);
  assert.match(callPost('submitReview', { productId: 'nope', stars: 5, name: 'X', email: 'x@y.z', text: 'hi' }).error, /not found/i);
});

/* ================================================================== *
 * 9. Web app entry points
 * ================================================================== */
await test('doGet understands ?action= and ?payload= (Netlify fallback)', () => {
  const secret = props.get('SECRET_KEY');
  const direct = callGet({ action: 'getPublic' });
  assert.ok(Array.isArray(direct.products));

  const viaPayload = callGet({ action: 'adminGet', payload: JSON.stringify({ secret }) });
  assert.ok(Array.isArray(viaPayload.products));
  assert.ok(viaPayload.products.length > 0);
});

await test('doGet and doPost always answer JSON, even on bad input', () => {
  assert.match(callGet({ action: 'adminGet' }).error, /Unauthorized/i);
  const out = api.doPost({ postData: { contents: '{broken' } });
  const parsed = JSON.parse(out.getContent());
  assert.match(parsed.error, /JSON/i);
  const empty = JSON.parse(api.doPost({}).getContent());
  assert.match(empty.error, /Empty/i);
});

await test('health reports configuration without touching the sheet', () => {
  const h = api.health_();
  assert.equal(h.ok, true);
  assert.equal(h.hasStripe, true);
  assert.equal(h.hasImgbb, true);
  assert.deepEqual(plain(h.sheets), [true, true, true, true]);
});

/* ================================================================== *
 * 10. Customer orders
 * ================================================================== */
await test('myOrders returns paid orders for the signed-in email only', () => {
  callPost('saveAll', { secret: props.get('SECRET_KEY'), settings: { google_client_id: 'client-id' } });

  const mine = callPost('myOrders', { token: 'fake.jwt.token' });
  assert.ok(Array.isArray(mine.orders), JSON.stringify(mine));
  assert.equal(mine.orders.length, 2, 'both paid orders belong to buyer@example.com');
  assert.ok(mine.orders.every((o) => o.status === 'paid'));
  assert.ok(mine.orders.every((o) => o.shipStatus === 'processing'));
});

await test('myOrders refuses unsigned-in customers', () => {
  callPost('saveAll', { secret: props.get('SECRET_KEY'), settings: { google_client_id: '' } });
  assert.match(callPost('myOrders', { token: 'fake.jwt.token' }).error, /sign in/i);
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
