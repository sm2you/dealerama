/**
 * Runs the REAL inline script from public/admin.html inside a fake DOM.
 *
 *   node test/admin-dom.test.mjs
 *
 * The page has produced several runtime bugs that static checks cannot see
 * (calling a wiring function with data instead of elements, a render error
 * reported as a wrong secret), so this signs in, expands a product, edits it,
 * validates, and saves — asserting the exact payload.
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

const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((r) => setTimeout(r, 10));

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */
function createDom() {
  const byId = new Map();
  const rows = [];
  const chips = ['all', 'live', 'draft', 'upcoming', 'archived'].map((f) => {
    const b = fake('button');
    b.dataset.f = f;
    return b;
  });

  function fake(tag = 'div') {
    const node = {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      style: {},
      className: '',
      textContent: '',
      value: '',
      type: tag === 'input' ? 'text' : '',
      checked: false,
      disabled: false,
      hidden: false,
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
      setAttribute(k, v) { this['attr_' + k] = v; },
      removeAttribute(k) { delete this['attr_' + k]; },
      appendChild() {},
      insertAdjacentHTML() {},
      remove() {},
      focus() {},
      blur() {},
      setSelectionRange() {},
      scrollIntoView() {},
      getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 0, right: 0, width: 0, height: 0 }),
      closest: () => null,
      matches: () => false,
      querySelector(sel) {
        if (!this._q.has(sel)) this._q.set(sel, fake(sel === '[data-toggle]' ? 'button' : 'input'));
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
          rows.length = 0;
          const rx = /data-pid="([^"]+)"\s+data-status="([^"]*)"\s+data-search="([^"]*)"/g;
          let m;
          while ((m = rx.exec(String(v)))) {
            const row = fake('article');
            row.dataset.pid = m[1];
            row.dataset.status = m[2];
            row.dataset.search = m[3];
            rows.push(row);
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
      if (sel === '#pane-products [data-pid]') return rows;
      if (sel.includes('[data-pid]') && sel.includes('[data-dirty]')) return rows.filter((r) => r.dataset.dirty);
      if (sel === '#filters button' || sel === '#pane-products #filters button') return chips;
      if (sel.includes('[data-rid]') || sel.includes('[data-oid]')) return [];
      return [];
    },
    addEventListener() {},
    body: fake('body'),
    documentElement: { className: '' }
  };

  const filters = document.getElementById('filters');
  filters.querySelectorAll = (sel) => (sel === 'button' ? chips : []);

  return { document, rows, chips };
}

function fixture() {
  return {
    id: 'p1',
    title: 'Caterpillar Hoodie',
    description: '<p>Nice</p>',
    status: 'draft',
    dealType: 'daily',
    basePrice: 31.99,
    price: 31.99,
    qty: 5,
    sold: 2,
    images: ['https://i.ibb.co/a.jpg'],
    startsAt: '2025-06-01',
    preorder: false,
    videoUrl: '',
    rating: 0,
    reviewCount: 0,
    variants: {
      options: [{ name: 'Color', values: ['Black', 'Navy'] }, { name: 'Size', values: ['S', 'M'] }],
      items: [
        { key: 'Black|S', price: '', qty: 2, sold: 1, image: '' },
        { key: 'Black|M', price: '', qty: 3, sold: 0, image: '' },
        { key: 'Navy|S', price: '', qty: 4, sold: 2, image: '' },
        { key: 'Navy|M', price: '', qty: 0, sold: 3, image: '' }
      ]
    }
  };
}

function run({ version = '5.1.0', product = fixture() } = {}) {
  const dom = createDom();
  const calls = [];
  const settings = { site_name: 'Dealerama', site_url: 'https://dealerama.netlify.app', footer_pages: '' };

  const api = async (body) => {
    calls.push(body);
    if (body.action === 'adminGet') {
      return {
        version,
        products: [product],
        reviews: [],
        orders: [],
        settings,
        keysSet: { STRIPE_SECRET_KEY: false, IMGBB_API_KEY: true, SECRET_KEY: true }
      };
    }
    if (body.action === 'saveAll') return { success: true };
    return {};
  };

  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    api,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    sessionStorage: { getItem: () => 'test-secret', setItem() {}, clear() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    document: dom.document,
    window: { addEventListener() {}, location: { reload() {} } },
    location: { reload() {} },
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    stars: () => '<span class="stars"></span>',
    PLACEHOLDER: 'https://placehold.co/600x600',
    FONTS: ['system-ui'],
    pagesFrom: () => [],
    URL: { createObjectURL: () => 'blob:x' },
    Image: class {},
    Event: class {}
  });

  vm.runInContext(inline, ctx, { filename: 'admin.html' });
  return { ctx, calls, ...dom };
}

/** Expand the first row the way a click would. */
function expand(env) {
  const row = env.rows[0];
  row.querySelector('[data-toggle]').onclick();
  return row.querySelector('.pedit');
}

/* ------------------------------------------------------------------ */
await test('signing in renders the product list without throwing', async () => {
  const env = run();
  await tick();
  assert.equal(env.calls[0].action, 'adminGet');
  assert.equal(env.rows.length, 1, 'one product row');
  assert.equal(env.document.getElementById('msg').textContent, '', 'no error message');
});

await test('product rows are wired to DOM elements', async () => {
  const env = run();
  await tick();
  const toggle = env.rows[0].querySelector('[data-toggle]');
  assert.equal(typeof toggle.onclick, 'function', 'the row toggle must be wired');
});

await test('expanding a row lazily renders the editor with its variants', async () => {
  const env = run();
  await tick();
  const editor = expand(env);
  assert.equal(editor.dataset.rendered, '1', 'editor marked as rendered');
  assert.match(editor.innerHTML, /data-vkey="Black\|S"/, 'variant table rendered');
  assert.match(editor.innerHTML, /data-f="sold"/, 'sold is editable');
  assert.match(editor.innerHTML, /data-f="qty"/);
  assert.doesNotMatch(editor.innerHTML, /data-secret=/, 'private keys belong to the settings pane only');
});

await test('editor controls are wired', async () => {
  const env = run();
  await tick();
  const editor = expand(env);
  for (const sel of ['[data-build]', '[data-clear]', '[data-addopt]', '[data-applysold]']) {
    assert.equal(typeof editor.querySelector(sel).onclick, 'function', sel + ' must have a handler');
  }
  assert.equal(typeof editor.querySelector('[data-revert]').onclick, 'function', 'revert must be wired');
  assert.equal(typeof editor.querySelector('.upl').onchange, 'function', 'upload must be wired');
  assert.equal(typeof editor.querySelector('.del').onchange, 'function', 'delete must be wired');
});

await test('save sends the edited fields including stock and sold', async () => {
  const env = run();
  await tick();
  const row = env.rows[0];
  const editor = expand(env);

  editor._qa.set('[data-f]', [
    { dataset: { f: 'title' }, value: 'Edited Hoodie', type: 'text', disabled: false },
    { dataset: { f: 'price' }, value: '29.99', type: 'number', disabled: false },
    { dataset: { f: 'qty' }, value: '4', type: 'number', disabled: false },
    { dataset: { f: 'sold' }, value: '7', type: 'number', disabled: false },
    { dataset: { f: 'images' }, value: 'https://i.ibb.co/a.jpg\nhttps://i.ibb.co/b.jpg', type: 'textarea', disabled: false },
    {
      dataset: { f: 'variants' },
      type: 'hidden',
      disabled: false,
      value: JSON.stringify({ options: [{ name: 'Size', values: ['M'] }], items: [{ key: 'M', price: 29.99, qty: 4, sold: 6, image: '' }] })
    }
  ]);
  row.dataset.dirty = '1';

  await env.document.getElementById('save').onclick();
  await tick();

  const saved = env.calls.find((c) => c.action === 'saveAll');
  assert.ok(saved, 'saveAll must be called');
  const fields = plain(saved.products[0].fields);
  assert.equal(saved.products[0].id, 'p1');
  assert.equal(fields.title, 'Edited Hoodie');
  assert.equal(fields.qty, '4');
  assert.equal(fields.sold, '7', 'sold must be sent to the backend');
  assert.deepEqual(fields.images, ['https://i.ibb.co/a.jpg', 'https://i.ibb.co/b.jpg']);
  assert.deepEqual(fields.variants.items, [{ key: 'M', price: 29.99, qty: 4, sold: 6, image: '' }]);
});

await test('validation blocks the save and points at the field', async () => {
  const env = run();
  await tick();
  const row = env.rows[0];
  const editor = expand(env);
  editor._qa.set('[data-f]', [
    { dataset: { f: 'title' }, value: '   ', type: 'text', disabled: false },
    { dataset: { f: 'price' }, value: '10', type: 'number', disabled: false },
    { dataset: { f: 'images' }, value: '', type: 'textarea', disabled: false },
    { dataset: { f: 'variants' }, value: '', type: 'hidden', disabled: false }
  ]);
  row.dataset.dirty = '1';

  await env.document.getElementById('save').onclick();
  await tick();

  assert.equal(env.calls.some((c) => c.action === 'saveAll'), false, 'nothing may be saved');
  assert.match(env.document.getElementById('msg').textContent, /need attention/i);
  assert.equal(row.dataset.dirty, '1', 'the row stays dirty');
});

await test('a render failure is reported as such, never as a wrong secret', async () => {
  const dom = createDom();
  const api = async (body) => (body.action === 'adminGet'
    ? { version: '5.1.0', products: [{ id: 'x' }], reviews: [], orders: [], settings: {}, keysSet: {} }
    : {});
  const ctx = vm.createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    api,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    sessionStorage: { getItem: () => 'secret', setItem() {}, clear() {} },
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    document: dom.document,
    window: { addEventListener() {}, location: { reload() {} } },
    location: { reload() {} },
    esc: (s) => String(s == null ? '' : s),
    stars: () => '',
    PLACEHOLDER: 'https://placehold.co/600x600',
    FONTS: ['system-ui'],
    pagesFrom: () => [],
    URL: { createObjectURL: () => '' },
    Image: class {},
    Event: class {}
  });

  const pane = dom.document.getElementById('pane-products');
  Object.defineProperty(pane, 'innerHTML', { configurable: true, set() { throw new Error('boom'); }, get() { return ''; } });

  vm.runInContext(inline, ctx, { filename: 'admin.html' });
  await tick();

  const msg = dom.document.getElementById('msg').textContent;
  assert.match(msg, /failed to render/i);
  assert.doesNotMatch(msg, /secret/i);
  assert.equal(dom.document.getElementById('app').classList.contains('hidden'), false);
});

await test('sold editing is disabled when the backend is older than 5.1.0', async () => {
  const env = run({ version: '5.0.0' });
  await tick();
  const editor = expand(env);
  assert.match(editor.innerHTML, /data-f="sold"[^>]*disabled/, 'sold input must be read-only on 5.0');
  assert.match(editor.innerHTML, /read-only/, 'the UI must say so');
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
