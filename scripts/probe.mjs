#!/usr/bin/env node
/**
 * Tells you which build is actually live, and whether the API route works.
 *
 *   node scripts/probe.mjs --site https://dealerama.netlify.app
 *   node scripts/probe.mjs                    # uses SITE_URL / .env.local
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function envFileValue(key) {
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(key + '=')) return t.slice(key.length + 1).trim();
  }
  return '';
}

const argSite = process.argv.find((a) => a.startsWith('--site='));
const argIdx = process.argv.indexOf('--site');
const site = String(
  (argSite ? argSite.split('=')[1] : argIdx > -1 ? process.argv[argIdx + 1] : '') ||
    process.env.SITE_URL ||
    envFileValue('SITE_URL') ||
    ''
)
  .trim()
  .replace(/\/+$/, '');

if (!site) {
  console.error('No site URL. Pass --site https://… or set SITE_URL / .env.local.');
  process.exit(2);
}

const get = async (path, timeout = 20000) => {
  try {
    const res = await fetch(site + path, { cache: 'no-store', signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { status: 0, type: '', text: '', error: e.message };
  }
};

const row = (label, ok, detail) => console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));

console.log('Probing ' + site + '\n');

/* --- which build is deployed? --- */
const index = await get('/index.html');
const admin = await get('/admin.html');
const sitejs = await get('/site.js');

console.log('Static files');
row('index.html served', index.status === 200, 'HTTP ' + index.status + ', ' + index.text.length + ' bytes');
row('admin.html served', admin.status === 200, 'HTTP ' + admin.status + ', ' + admin.text.length + ' bytes');
if (sitejs.status === 200) {
  const modern = sitejs.text.includes('apiRequest');
  const legacy = sitejs.text.includes("const API = '/.netlify/functions/api'");
  row('site.js is the v5 build', modern && !legacy, modern ? 'shared api()/getData() found' : 'OLD build (fetch(API) helper)');
} else {
  row('site.js served', false, 'HTTP ' + sitejs.status);
}
const indexModern = index.text.includes('getData()');
row('index.html is the v5 build', indexModern, indexModern ? '' : 'OLD build — Netlify has not deployed the push yet');
const adminModern = admin.text.includes('Nothing changed.');
row('admin.html is the v5 build', adminModern, adminModern ? '' : 'OLD build');

/* --- API --- */
console.log('\nAPI');
const health = await get('/api?action=health');
const healthJson = (() => {
  try {
    return JSON.parse(health.text);
  } catch {
    return null;
  }
})();
row('/api reachable', health.status === 200 && !!healthJson, 'HTTP ' + health.status + ' ' + health.type);
if (healthJson) {
  row('APPS_SCRIPT_URL configured', healthJson.appsScriptConfigured === true);
} else {
  console.log('     body: ' + health.text.replace(/\s+/g, ' ').slice(0, 140));
}

const catalog = await get('/api');
let products = [];
if (catalog.status === 200) {
  try {
    products = (JSON.parse(catalog.text).products || []).length;
  } catch {
    /* not JSON */
  }
}
row('catalogue loads', catalog.status === 200, products ? products + ' product(s)' : 'HTTP ' + catalog.status);

const legacyPath = await get('/.netlify/functions/api');
row('/.netlify/functions/api reachable', legacyPath.status === 200, 'HTTP ' + legacyPath.status);

/* --- verdict --- */
console.log('\nVerdict');
const buildOk = indexModern && adminModern;
if (!buildOk) {
  console.log('  Netlify is serving an older build. Push/deploy the repo, then re-run this probe.');
}
if (!healthJson) {
  console.log('  The API route is missing. Check: publish dir = public, functions dir = netlify/functions,');
  console.log('  netlify.toml committed, and that the deploy log shows the "api" function bundling with esbuild.');
}
if (healthJson && !healthJson.appsScriptConfigured) {
  console.log('  APPS_SCRIPT_URL is not set in Netlify → Site configuration → Environment variables.');
}
if (buildOk && healthJson && healthJson.appsScriptConfigured) {
  console.log('  Everything is live and wired.');
}
process.exit(buildOk && healthJson ? 0 : 1);
