/**
 * Tests scripts/configure.mjs against a local fake Apps Script + fake Netlify.
 * Proves that README step 4 is automated correctly before anything is pointed
 * at a real deployment.
 *
 *   node test/configure.test.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configure, parseArgs } from '../scripts/configure.mjs';

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

/* Fake backend: one server plays Apps Script (/exec) and Netlify (/api). */
function startServer({ secret = 'test-admin-secret-123' } = {}) {
  const state = {
    settings: { site_name: 'Dealerama', site_url: '', business_name: '', google_client_id: '' },
    keys: { STRIPE_SECRET_KEY: false, IMGBB_API_KEY: false, SECRET_KEY: true },
    products: [
      { id: 'p1', title: 'Live deal', status: 'live', qty: 3, price: 19.99, variants: null },
      { id: 'p2', title: 'Draft deal', status: 'draft', qty: 5, price: 9.99, variants: null }
    ],
    requests: []
  };

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      state.requests.push({ method: req.method, path: url.pathname, action: url.searchParams.get('action') });

      if (req.method === 'GET' && url.pathname === '/exec' && url.searchParams.get('action') === 'health') {
        return send(res, 200, {
          ok: true,
          version: '5.0.0',
          sheets: [true, true, true, true],
          hasSecret: true,
          hasStripe: state.keys.STRIPE_SECRET_KEY,
          hasImgbb: state.keys.IMGBB_API_KEY
        });
      }

      if (req.method === 'GET' && url.pathname === '/api' && url.searchParams.get('action') === 'health') {
        return send(res, 200, { ok: true, appsScriptConfigured: true, appsScriptLooksValid: true });
      }

      if (req.method === 'GET' && url.pathname === '/api') {
        return send(res, 200, {
          products: state.products.filter((p) => p.status === 'live'),
          settings: state.settings,
          reviews: []
        });
      }

      if (req.method === 'POST' && url.pathname === '/exec') {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'bad json' });
        }
        if (body.secret !== secret) return send(res, 200, { error: 'Unauthorized' });
        if (body.action === 'adminGet') {
          return send(res, 200, {
            products: state.products,
            reviews: [],
            orders: [],
            settings: state.settings,
            keysSet: state.keys
          });
        }
        if (body.action === 'saveAll') {
          Object.assign(state.settings, body.settings || {});
          Object.keys(body.keys || {}).forEach((k) => {
            state.keys[k] = true;
            if (k === 'SECRET_KEY') secret = body.keys[k];
          });
          return send(res, 200, { success: true });
        }
        return send(res, 200, { error: 'Unknown action' });
      }

      send(res, 404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      resolve({
        base,
        state,
        getSecret: () => secret,
        close: () =>
          new Promise((r) => {
            if (server.closeAllConnections) server.closeAllConnections();
            server.close(r);
          })
      });
    });
  });
}

const logs = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)) };
};

/* ------------------------------------------------------------------ */
await test('configure() writes site_url, Stripe and ImgBB keys and verifies them', async () => {
  const fake = await startServer();
  const out = logs();
  try {
    const result = await configure(
      {
        url: fake.base + '/exec',
        secret: 'test-admin-secret-123',
        'site-url': fake.base,
        stripe: 'sk_test_example_key',
        imgbb: 'imgbb-example-key',
        business: 'Deal Station',
        email: 'owner@example.com',
        'google-client-id': 'client.apps.googleusercontent.com'
      },
      { log: out.log }
    );

    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
    assert.equal(fake.state.settings.site_url, fake.base);
    assert.equal(fake.state.settings.business_name, 'Deal Station');
    assert.equal(fake.state.settings.contact_email, 'owner@example.com');
    assert.equal(fake.state.keys.STRIPE_SECRET_KEY, true);
    assert.equal(fake.state.keys.IMGBB_API_KEY, true);
    assert.equal(result.state.buyable, 1, 'only the live, in-stock product is buyable');
    assert.equal(result.checks.find((c) => c.name === '/api deployed').ok, true);
    assert.match(out.lines.join('\n'), /Stripe key\s+= sk_t…ey/, 'the key is masked in output');
    assert.doesNotMatch(out.lines.join('\n'), /sk_test_example_key/, 'the raw key is never printed');
  } finally {
    await fake.close();
  }
});

await test('configure() reports a wrong admin secret instead of pretending to work', async () => {
  const fake = await startServer();
  try {
    await assert.rejects(
      () => configure({ url: fake.base + '/exec', secret: 'wrong' }, { log: () => {} }),
      /Admin login failed: Unauthorized/
    );
  } finally {
    await fake.close();
  }
});

await test('configure() refuses an /edit URL with a clear message', async () => {
  await assert.rejects(
    () => configure({ url: 'https://script.google.com/d/abc/edit', secret: 'x' }, { log: () => {} }),
    /\/exec URL/
  );
});

await test('configure() surfaces a non-JSON (HTML) Apps Script response', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>Sign in to continue</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await assert.rejects(
      () => configure({ url: base + '/exec', secret: 'x' }, { log: () => {} }),
      /non-JSON page[\s\S]*Anyone/
    );
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

await test('rotating the admin secret switches the follow-up calls to the new one', async () => {
  const fake = await startServer();
  try {
    const result = await configure(
      {
        url: fake.base + '/exec',
        secret: 'test-admin-secret-123',
        'new-secret': 'a-brand-new-secret-42',
        'site-url': fake.base,
        stripe: 'sk_test_new',
        imgbb: 'imgbb_new'
      },
      { log: () => {} }
    );
    assert.equal(fake.getSecret(), 'a-brand-new-secret-42', 'the backend now expects the new secret');
    assert.equal(result.ok, true, JSON.stringify(result.checks.filter((c) => !c.ok)));
    assert.equal(result.checks.find((c) => c.name === 'Stripe key set').ok, true);
  } finally {
    await fake.close();
  }
});

await test('--verify-only does not write', async () => {
  const fake = await startServer();
  try {
    const result = await configure(
      {
        url: fake.base + '/exec',
        secret: 'test-admin-secret-123',
        'site-url': fake.base,
        stripe: 'sk_test_should_not_be_saved',
        'verify-only': true
      },
      { log: () => {} }
    );
    assert.equal(fake.state.keys.STRIPE_SECRET_KEY, false, 'nothing may be written in verify-only mode');
    assert.equal(result.checks.find((c) => c.name === 'Stripe key set').ok, false);
  } finally {
    await fake.close();
  }
});

await test('parseArgs handles --flag value, --flag=value and bare flags', () => {
  assert.deepEqual(parseArgs(['--url', 'https://x/exec', '--json', '--stripe=sk_1']), {
    url: 'https://x/exec',
    json: true,
    stripe: 'sk_1'
  });
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
