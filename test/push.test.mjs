/**
 * Tests scripts/push.mjs with a fake GitHub API and a fake git runner.
 * No network, no credentials, no real repository.
 *
 *   node test/push.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push } from '../scripts/push.mjs';
import { readEnvFile, mapEnvFile } from '../scripts/configure.mjs';

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

function fakeGitHub({ repoExists = false, createStatus = 201, tokenOk = true } = {}) {
  const calls = [];
  let created = false;

  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://api.github.com', '');
    calls.push({ method, path, body: init.body });

    const reply = (status, body) => ({
      status,
      text: async () => JSON.stringify(body)
    });

    if (path === '/user') {
      return tokenOk ? reply(200, { login: 'sunny' }) : reply(401, { message: 'Bad credentials' });
    }
    if (path.endsWith('/commits?per_page=1')) {
      return reply(200, [{ sha: 'abcdef1234567890' }]);
    }
    if (path.startsWith('/repos/') && method === 'GET') {
      if (created || repoExists) return reply(200, { full_name: 'sunny/dealerama', private: true });
      return reply(404, { message: 'Not Found' });
    }
    if (path === '/user/repos' && method === 'POST') {
      if (createStatus !== 201) return reply(createStatus, { message: 'denied' });
      created = true;
      return reply(201, { full_name: 'sunny/dealerama', private: true });
    }
    if (path.endsWith('/commits?per_page=1')) {
      return reply(200, [{ sha: 'abcdef1234567890' }]);
    }
    return reply(404, { message: 'unexpected ' + path });
  };

  return { fetchImpl, calls, get created() { return created; } };
}

/* ------------------------------------------------------------------ */
await test('push() creates the repo, adds a credential-free remote and pushes main', async () => {
  const gh = fakeGitHub();
  const gitCalls = [];
  const run = (args) => {
    gitCalls.push(args);
    if (args[0] === 'remote' && args[1] === 'remove') throw new Error('no such remote');
  };

  const result = await push({ token: 'ghp_test', repo: 'dealerama' }, { fetchImpl: gh.fetchImpl, run, log: () => {} });

  assert.equal(result.created, true);
  assert.equal(result.remote, 'https://github.com/sunny/dealerama.git');
  assert.equal(result.sha, 'abcdef1');

  const create = gh.calls.find((c) => c.method === 'POST' && c.path === '/user/repos');
  assert.ok(create, 'POST /user/repos must be called');
  const payload = JSON.parse(create.body);
  assert.equal(payload.name, 'dealerama');
  assert.equal(payload.private, true, 'defaults to a private repo');
  assert.equal(payload.auto_init, false, 'an initialised repo would block the first push');

  const add = gitCalls.find((a) => a[0] === 'remote' && a[1] === 'add');
  assert.deepEqual(add, ['remote', 'add', 'origin', 'https://github.com/sunny/dealerama.git']);
  assert.ok(!JSON.stringify(add).includes('ghp_test'), 'the token must never be stored in the remote');

  const pushArgs = gitCalls.find((a) => a.includes('push'));
  assert.ok(pushArgs.includes('HEAD:refs/heads/main'));
  assert.ok(pushArgs.some((a) => a.startsWith('http.https://github.com/.extraheader=AUTHORIZATION: basic ')));
  assert.ok(pushArgs.includes('http.sslBackend=openssl'), 'needed on this Windows host');
});

await test('push() reuses an existing repository', async () => {
  const gh = fakeGitHub({ repoExists: true });
  const gitCalls = [];
  const run = (args) => {
    gitCalls.push(args);
    if (args[0] === 'remote' && args[1] === 'remove') return;
  };
  const result = await push({ token: 'ghp_test', owner: 'sunny', repo: 'dealerama' }, { fetchImpl: gh.fetchImpl, run, log: () => {} });

  assert.equal(result.created, false);
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0, 'no repo creation when it exists');
  assert.ok(gitCalls.find((a) => a.includes('push')));
});

await test('push() explains a rejected token', async () => {
  const gh = fakeGitHub({ tokenOk: false });
  await assert.rejects(
    () => push({ token: 'bad' }, { fetchImpl: gh.fetchImpl, run: () => {}, log: () => {} }),
    /401/
  );
});

await test('push() explains a token that cannot create repositories', async () => {
  const gh = fakeGitHub({ createStatus: 403 });
  await assert.rejects(
    () => push({ token: 'ghp_test' }, { fetchImpl: gh.fetchImpl, run: () => {}, log: () => {} }),
    /Administration: write|repo scope/
  );
});

await test('push() requires a token', async () => {
  await assert.rejects(() => push({}, { fetchImpl: async () => {}, run: () => {}, log: () => {} }), /Missing token/);
});

/* ------------------------------------------------------------------ */
await test('.env.local parsing ignores comments, quotes and blank lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealerama-env-'));
  const file = join(dir, '.env.local');
  try {
    writeFileSync(
      file,
      ['# comment', '', 'APPS_SCRIPT_URL="https://script.google.com/macros/s/A/exec"', "ADMIN_SECRET='abc123'", 'SITE_URL=https://dealerama.netlify.app', 'UNKNOWN=ignored', 'EMPTY='].join('\n')
    );
    const values = readEnvFile(file);
    assert.equal(values.APPS_SCRIPT_URL, 'https://script.google.com/macros/s/A/exec');
    assert.equal(values.ADMIN_SECRET, 'abc123');
    assert.equal(values.EMPTY, '');

    const mapped = mapEnvFile(values);
    assert.equal(mapped.url, 'https://script.google.com/macros/s/A/exec');
    assert.equal(mapped.secret, 'abc123');
    assert.equal(mapped['site-url'], 'https://dealerama.netlify.app');
    assert.equal(mapped.UNKNOWN, undefined, 'unknown keys are ignored');
    assert.equal(mapped.stripe, undefined, 'empty values are ignored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('readEnvFile tolerates a missing file', () => {
  assert.deepEqual(readEnvFile(join(tmpdir(), 'definitely-not-here.env')), {});
});

/* ------------------------------------------------------------------ */
console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  failures.forEach((f) => console.error('\n--- ' + f.name + '\n' + (f.error && f.error.stack)));
  process.exit(1);
}
