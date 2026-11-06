/**
 * Tests for netlify/functions/api.js — the function that used to answer every
 * GET with "Method Not Allowed".
 *
 *   node test/api.test.mjs
 *
 * No network and no dependencies: globalThis.fetch is replaced with a fake
 * Google Apps Script.
 */
import assert from 'node:assert/strict';
import handler from '../netlify/functions/api.js';

const APP = 'https://script.google.com/macros/s/TESTDEPLOY/exec';

let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log('  ok  ' + name);
    })
    .catch((e) => {
      failures.push({ name, error: e });
      console.log('FAIL  ' + name + '\n      ' + (e && e.message));
    });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

let seen = [];
function mockFetch(fn) {
  seen = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body };
    seen.push(record);
    return fn(record);
  };
}

const post = (payload) =>
  new Request('https://dealerama.netlify.app/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });

const get = (qs = '') => new Request('https://dealerama.netlify.app/api' + qs, { method: 'GET' });

/* ------------------------------------------------------------------ */
process.env.APPS_SCRIPT_URL = APP;

await test('GET returns JSON (this used to be a plain-text 405)', async () => {
  mockFetch(() =>
    jsonResponse({
      products: [{ id: "'p1'", title: 'Running Shoes', price: 89.99, qty: 5, images: '["https://i.ibb.co/a.jpg"]' }],
      settings: { site_name: 'Dealerama' },
      reviews: []
    })
  );

  const res = await handler(get());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const body = await res.json();
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].id, 'p1', 'rogue apostrophe must be stripped');
  assert.deepEqual(body.products[0].images, ['https://i.ibb.co/a.jpg']);
  assert.equal(body.settings.site_name, 'Dealerama');
  assert.equal(seen[0].method, 'POST', 'GET is proxied to Apps Script as a POST');
  assert.deepEqual(JSON.parse(seen[0].body), { action: 'getPublic' });
});

await test('GET never leaks a 405 body, even when Apps Script misbehaves', async () => {
  mockFetch(() => new Response('Method Not Allowed', { status: 405 }));
  const res = await handler(get());
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.error, 'must still be JSON with an error field');
  assert.doesNotMatch(body.error, /^\s*Method Not Allowed\s*$/);
});

await test('POST saveAll is forwarded untouched and is not cached', async () => {
  mockFetch(() => jsonResponse({ success: true }));
  const payload = {
    action: 'saveAll',
    secret: 'super-secret-admin-key-123',
    products: [{ id: 'p1', fields: { title: 'New title', status: 'live' } }],
    settings: { site_name: 'Shop' }
  };
  const res = await handler(post(payload));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const forwarded = JSON.parse(seen[0].body);
  assert.equal(forwarded.action, 'saveAll');
  assert.equal(forwarded.secret, payload.secret);
  assert.deepEqual(forwarded.products, payload.products);
  assert.deepEqual(forwarded.settings, payload.settings);
});

await test('admin errors come back as JSON with HTTP 200 (so the UI can show them)', async () => {
  mockFetch(() => jsonResponse({ error: 'Wrong admin secret.' }));
  const res = await handler(post({ action: 'adminGet', secret: 'nope' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).error, 'Wrong admin secret.');
});

await test('an HTML page from Apps Script produces an actionable error', async () => {
  mockFetch(() => new Response('<!DOCTYPE html><html><body>Sign in</body></html>', { status: 200 }));
  const res = await handler(get());
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /HTML/i);
  assert.match(body.error, /\/exec/);
});

await test('a POST that Apps Script rejects with 405 is retried as GET', async () => {
  mockFetch((r) => {
    if (r.method === 'POST') return new Response('Method Not Allowed', { status: 405 });
    return jsonResponse({ products: [{ id: 'p9', title: 'Fallback product' }], settings: {}, reviews: [] });
  });

  const res = await handler(get());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.via, 'GET');
  assert.equal(body.products[0].title, 'Fallback product');

  const retry = seen.find((r) => r.method === 'GET');
  assert.ok(retry, 'a GET retry must be issued');
  assert.match(retry.url, /[?&]action=getPublic/);
  assert.match(retry.url, /payload=/);
});

await test('variants are normalised: legacy "Red / M" keys become "Red|M", stock is summed', async () => {
  mockFetch(() =>
    jsonResponse({
      products: [
        {
          id: 'p2',
          title: 'Tee',
          price: '19.99',
          images: '[]',
          variantsJson: JSON.stringify({
            options: [
              { name: 'Color', values: ['Red', 'Blue'] },
              { name: 'Size', values: ['S', 'M'] }
            ],
            items: [
              { key: 'Red / M', price: '21.50', qty: '4', image: 'https://i.ibb.co/r.jpg' },
              { key: 'Blue | S', price: '19.99', qty: '6', sold: '2' }
            ]
          })
        }
      ],
      settings: {},
      reviews: []
    })
  );

  const body = await (await handler(get())).json();
  const p = body.products[0];
  assert.deepEqual(p.variants.items.map((i) => i.key), ['Red|M', 'Blue|S']);
  assert.equal(p.variants.items[0].price, 21.5);
  assert.equal(p.variants.items[0].image, 'https://i.ibb.co/r.jpg');
  assert.equal(p.qty, 10, 'stock is summed from the variants');
  assert.equal(p.sold, 2);
  assert.equal(p.price, 19.99, 'display price is the cheapest variant');
  assert.equal(p.priceFrom, true);
});

await test('reviews and orders are normalised too', async () => {
  mockFetch(() =>
    jsonResponse({
      products: [],
      settings: {},
      reviews: [{ id: 7, productId: 'p1', stars: '5', name: 'Ann', verified: 'TRUE' }],
      orders: [{ id: 'o1', qty: '2', amount: '39.98', shipStatus: 'shipped' }]
    })
  );
  const body = await (await handler(post({ action: 'adminGet', secret: 'x' }))).json();
  assert.equal(body.reviews[0].id, '7');
  assert.equal(body.reviews[0].stars, 5);
  assert.equal(body.reviews[0].verified, true);
  assert.equal(body.orders[0].qty, 2);
  assert.equal(body.orders[0].amount, 39.98);
});

await test('CORS preflight succeeds', async () => {
  mockFetch(() => jsonResponse({}));
  const res = await handler(new Request('https://dealerama.netlify.app/api', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

await test('unsupported methods get a JSON 405 (not plain text)', async () => {
  mockFetch(() => jsonResponse({}));
  const res = await handler(new Request('https://dealerama.netlify.app/api', { method: 'DELETE' }));
  assert.equal(res.status, 405);
  const body = await res.json();
  assert.match(body.error, /not allowed/i);
});

await test('health reports the Apps Script configuration without calling it', async () => {
  const res = await handler(get('?action=health'));
  const body = await res.json();
  assert.equal(body.appsScriptConfigured, true);
  assert.equal(body.appsScriptLooksValid, true);
  assert.equal(seen.length, 0, 'health must not hit Apps Script');
});

await test('a missing APPS_SCRIPT_URL gives a clear message, not a crash', async () => {
  delete process.env.APPS_SCRIPT_URL;
  const res = await handler(get());
  const body = await res.json();
  assert.match(body.error, /APPS_SCRIPT_URL/);
  process.env.APPS_SCRIPT_URL = APP;
});

await test('a /edit URL is rejected with a helpful message', async () => {
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/d/abc/edit';
  const body = await (await handler(get())).json();
  assert.match(body.error, /\/exec/);
  process.env.APPS_SCRIPT_URL = APP;
});

await test('an invalid JSON body is rejected cleanly', async () => {
  const res = await handler(post('{not json'));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/i);
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
