/**
 * Runs the REAL inline script from public/admin.html inside a fake DOM.
 *
 *   node test/admin-dom.test.mjs
 *
 * Why: the page shipped two bugs that no static check could catch —
 *   1) wireProductCard() was called with product DATA instead of DOM nodes,
 *      so signing in threw "card.querySelector is not a function";
 *   2) that crash was swallowed by the auth catch, so a valid secret looked
 *      like a wrong secret.
 * This test signs in, renders, and presses Save, asserting the exact payload.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = readFileSync(fileURLToPath(new URL('../public/admin.html', import.meta.url)), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.includes('wireProductCard'))
  .join('\n');

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

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */
function createDom() {
  const byId = new Map();
  const cards = [];
  const filterButtons = ['all', 'live', 'draft', 'upcoming', 'archived'].map((f) => {
    const b = fake('button');
    b.dataset.f = f;
    return b;
  });

  function fake(tag = 'div') {
    const node = {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      style: {},
      textContent: '',
      value: '',
      type: tag === 'input' ? 'text' : '',
      checked: false,
      disabled: false,
      files: [],
      onclick: null,
      onchange: null,
      oninput: null,
      _html: '',
      _q: new Map(),
      _qa: new Map(),
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        toggle(c, force) { if (force === undefined ? !this._set.has(c) : force) this._set.add(c); else this._set.delete(c); },
        contains(c) { return this._set.has(c); }
      },
      addEventListener() {},
      removeEventListener() {},
      getAttribute: () => null,
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      insertAdjacentHTML() {},
      remove() {},
      focus() {},
      setSelectionRange() {},
      closest: () => null,
      matches: () => false,
      querySelector(sel) {
        if (!this._q.has(sel)) this._q.set(sel, fake('input'));
        return this._q.get(sel);
      },
      querySelectorAll(sel) {
        if (!this._qa.has(sel)) this._qa.set(sel, []);
        return this._qa.get(sel);
      }
    };
    Object.defineProperty(node, 'innerHTML', {
      configurable: true,
      get() { return this._html; },
      set(v) {
        this._html = String(v);
        if (this === byId.get('pane-products')) {
          // Turn the rendered markup back into element references, the way a
          // browser would, so the wiring code gets real nodes.
          cards.length = 0;
          const rx = /data-pid="([^"]+)"\s+data-status="([^"]*)"\s+data-search="([^"]*)"/g;
          let m;
          while ((m = rx.exec(String(v)))) {
            const card = fake('article');
            card.dataset.pid = m[1];
            card.dataset.status = m[2];
            card.dataset.search = m[3];
            card._fields = [];
            card.querySelectorAll = (sel) => (sel === '[data-f]' ? card._fields : node.querySelectorAll(sel));
            cards.push(card);
          }
        }
      }
    });
    return node;
  }

  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, fake('div'));
      return byId.get(id);
    },
    querySelector(sel) {
      if (sel === '#pane-settings [data-k="footer_pages"]') return fake('input');
      return fake('div');
    },
    querySelectorAll(sel) {
      if (sel === '#pane-products [data-pid]') return cards;
      if (sel === '[data-pid][data-dirty]') return cards.filter((c) => c.dataset.dirty);
      if (sel === '#filters button' || sel === '#pane-products #filters button') return filterButtons;
      if (sel === '[data-rid][data-dirty]' || sel === '[data-oid][data-dirty]') return [];
      return [];
    },
    addEventListener() {},
    body: fake('body'),
    documentElement: { className: '' }
  };

  // #filters lives inside the rendered pane, but the code also reaches it by id.
  const filters = document.getElementById('filters');
  filters.querySelectorAll = (sel) => (sel === 'button' ? filterButtons : []);

  return { document, cards, filterButtons, byId };
}

function run() {
  const { document, cards, filterButtons } = createDom();
  const calls = [];
  const settings = { site_name: 'Dealerama', site_url: 'https://dealerama.netlify.app', footer_pages: '' };
  const products = [
    {
      id: 'p1',
      title: 'Caterpillar Hoodie',
      description: '<p>Nice</p>',
      status: 'draft',
      dealType: 'daily',
      basePrice: 31.99,
      price: 31.99,
      qty: 5,
      sold: 0,
      images: ['https://i.ibb.co/a.jpg'],
      startsAt: '2025-06-01',
      preorder: false,
      videoUrl: '',
      rating: 0,
      reviewCount: 0,
      variants: {
        options: [{ name: 'Color', values: ['Black', 'Navy'] }, { name: 'Size', values: ['S', 'M'] }],
        items: [
          { key: 'Black|S', price: '', qty: 0, sold: 0, image: '' },
          { key: 'Black|M', price: '', qty: 0, sold: 0, image: '' },
          { key: 'Navy|S', price: '', qty: 0, sold: 0, image: '' },
          { key: 'Navy|M', price: '', qty: 0, sold: 0, image: '' }
        ]
      }
    }
  ];

  const api = async (body) => {
    calls.push(body);
    if (body.action === 'adminGet') {
      return { products, reviews: [], orders: [], settings, keysSet: { STRIPE_SECRET_KEY: false, IMGBB_API_KEY: true, SECRET_KEY: true } };
    }
    if (body.action === 'saveAll') return { success: true };
    return {};
  };

  const ctx = vm.createContext({
    console,
    api,
    setTimeout,
    confirm: () => true,
    sessionStorage: { getItem: () => 'test-secret', setItem() {}, clear() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    document,
    window: { addEventListener() {}, location: { reload() {} } },
    location: { reload() {} },
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    money: (n) => '$' + Number(n || 0).toFixed(2),
    stars: () => '<span class="stars"></span>',
    PLACEHOLDER: 'https://placehold.co/600x600',
    FONTS: ['system-ui'],
    pagesFrom: () => [],
    URL: { createObjectURL: () => 'blob:x' },
    Image: class {},
    Event: class {}
  });

  vm.runInContext(inline, ctx, { filename: 'admin.html' });
  return { ctx, calls, cards, document, filterButtons };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Values created inside the VM come from another realm. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------------------ */
await test('signing in renders the page without throwing', async () => {
  const env = run();
  await tick();
  assert.equal(env.calls[0].action, 'adminGet', 'load() must call adminGet');
  assert.equal(env.cards.length, 1, 'one product card must be rendered');
  assert.equal(env.document.getElementById('msg').textContent, '', 'no error message should be shown');
});

await test('every rendered card is wired to a DOM element (not to product data)', async () => {
  const env = run();
  await tick();
  const card = env.cards[0];
  const box = card.querySelector('.vbox');
  assert.equal(typeof box.querySelector('[data-build]').onclick, 'function', 'Build grid must be wired');
  assert.equal(typeof box.querySelector('[data-clear]').onclick, 'function', 'Clear must be wired');
  assert.equal(typeof box.querySelector('[data-addopt]').onclick, 'function', 'Add option must be wired');
  assert.equal(typeof card.querySelector('.del').onchange, 'function', 'delete must be wired');
  assert.equal(typeof card.querySelector('.upl').onchange, 'function', 'upload must be wired');
});

await test('variant table is populated from the stored variants', async () => {
  const env = run();
  await tick();
  const markup = env.document.getElementById('pane-products').innerHTML;
  assert.match(markup, /data-vkey="Black\|S"/);
  assert.equal((markup.match(/class="vt vrow"/g) || []).length, 4, 'four variant rows expected');
});

await test('Save sends exactly the edited fields for dirty cards', async () => {
  const env = run();
  await tick();

  const card = env.cards[0];
  card.dataset.dirty = '1';
  card._fields = [
    { dataset: { f: 'title' }, value: 'Edited Hoodie', type: 'text', disabled: false },
    { dataset: { f: 'price' }, value: '29.99', type: 'number', disabled: false },
    { dataset: { f: 'qty' }, value: '4', type: 'number', disabled: false },
    { dataset: { f: 'images' }, value: 'https://i.ibb.co/a.jpg\nhttps://i.ibb.co/b.jpg', type: 'textarea', disabled: false },
    { dataset: { f: 'variants' }, value: '{"options":[{"name":"Size","values":["M"]}],"items":[{"key":"M","price":29.99,"qty":4}]}', type: 'hidden', disabled: false }
  ];

  await env.document.getElementById('save').onclick();
  await tick();

  const saved = env.calls.find((c) => c.action === 'saveAll');
  assert.ok(saved, 'saveAll must be called');
  assert.equal(saved.products.length, 1);
  assert.equal(saved.products[0].id, 'p1');
  assert.equal(saved.products[0].fields.title, 'Edited Hoodie');
  assert.equal(saved.products[0].fields.price, '29.99');
  assert.deepEqual(plain(saved.products[0].fields.images), ['https://i.ibb.co/a.jpg', 'https://i.ibb.co/b.jpg']);
  assert.deepEqual(plain(saved.products[0].fields.variants.items), [{ key: 'M', price: 29.99, qty: 4 }]);
});

await test('an unparseable variants cell degrades to an empty variant set', async () => {
  const env = run();
  await tick();
  const card = env.cards[0];
  card.dataset.dirty = '1';
  card._fields = [{ dataset: { f: 'variants' }, value: '{oops', type: 'hidden', disabled: false }];
  await env.document.getElementById('save').onclick();
  await tick();
  const saved = env.calls.find((c) => c.action === 'saveAll');
  assert.deepEqual(plain(saved.products[0].fields.variants), { options: [], items: [] });
});

await test('a render failure is reported as such, never as a wrong secret', async () => {
  const { document } = createDom();
  const calls = [];
  const api = async (body) => {
    calls.push(body);
    if (body.action === 'adminGet') {
      // A product with a shape the renderer cannot handle.
      return { products: [{ id: 'x' }], reviews: [], orders: [], settings: {}, keysSet: {} };
    }
    return {};
  };
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    api,
    setTimeout,
    confirm: () => true,
    sessionStorage: { getItem: () => 'secret', setItem() {}, clear() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    document,
    window: { addEventListener() {}, location: { reload() {} } },
    location: { reload() {} },
    esc: (s) => String(s == null ? '' : s),
    money: (n) => String(n),
    stars: () => '',
    PLACEHOLDER: 'https://placehold.co/600x600',
    FONTS: ['system-ui'],
    pagesFrom: () => [],
    URL: { createObjectURL: () => '' },
    Image: class {},
    Event: class {}
  });

  // Force a render error by making innerHTML assignment throw for the pane.
  const pane = document.getElementById('pane-products');
  Object.defineProperty(pane, 'innerHTML', { set() { throw new Error('boom'); }, get() { return ''; } });

  vm.runInContext(inline, ctx, { filename: 'admin.html' });
  await tick();

  const msg = document.getElementById('msg').textContent;
  assert.match(msg, /failed to render/i, 'the message must name a render failure');
  assert.doesNotMatch(msg, /wrong admin secret/i);
  assert.equal(document.getElementById('app').classList.contains('hidden'), false, 'the app must stay visible after a render failure');
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
