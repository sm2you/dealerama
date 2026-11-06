#!/usr/bin/env node
/**
 * One-off catalogue cleanup, driven through the same admin API the panel uses.
 *
 *   node scripts/repair-data.mjs                 # dry run: show what would change
 *   node scripts/repair-data.mjs --fix-entities  # decode HTML entities in titles
 *   node scripts/repair-data.mjs --draft-placeholders   # park "New product" rows
 *   node scripts/repair-data.mjs --fix-entities --draft-placeholders
 *   node scripts/repair-data.mjs ... --dry-run   # force no writes
 *
 * Titles are rendered with textContent, so a literal `&#39;` shows up as
 * "Women&#39;s". Descriptions are rendered as HTML, so a single `&amp;` is
 * correct there — only double-encoded entities (`&amp;#39;`) are repaired.
 *
 * Usage of --env.local: APPS_SCRIPT_URL, ADMIN_SECRET (or pass --url/--secret).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(key) {
  if (process.env[key]) return process.env[key];
  const p = join(ROOT, '.env.local');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(key + '=')) return t.slice(key.length + 1).trim();
  }
  return '';
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
  const inline = args.find((a) => a.startsWith(f + '='));
  if (inline) return inline.slice(f.length + 1);
  const i = args.indexOf(f);
  return i > -1 ? args[i + 1] : '';
};

const url = (val('--url') || env('APPS_SCRIPT_URL')).replace(/\/+$/, '');
const secret = val('--secret') || env('ADMIN_SECRET');
const fixEntities = has('--fix-entities');
const draftPlaceholders = has('--draft-placeholders');
const dryRun = has('--dry-run') || (!fixEntities && !draftPlaceholders);

if (!url || !secret) {
  console.error('Need an Apps Script URL and admin secret (flags or .env.local).');
  process.exit(2);
}

const ENTITY = /&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi;

function decodeEntities(input) {
  let out = String(input == null ? '' : input);
  let previous;
  let passes = 0;
  while (out !== previous && passes < 2) {
    previous = out;
    out = out.replace(ENTITY, (match, code) => {
      if (code[0] === '#') {
        const hex = code[1] === 'x' || code[1] === 'X';
        const n = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : match;
      }
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      const k = code.toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : match;
    });
    passes++;
  }
  return out;
}

/** Only un-double-encode; a single &amp; is correct inside HTML descriptions. */
function fixDoubleEncoded(html) {
  return String(html == null ? '' : html).replace(/&amp;(#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, '&$1');
}

async function api(body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret, ...body })
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Backend returned non-JSON (HTTP ' + res.status + '): ' + text.slice(0, 120));
  }
}

const state = await api({ action: 'adminGet' });
if (state.error) {
  console.error('adminGet failed: ' + state.error);
  process.exit(1);
}

const changes = [];
for (const p of state.products) {
  const next = {};
  const decoded = decodeEntities(p.title);
  if (fixEntities && decoded !== p.title) next.title = decoded;

  if (fixEntities && p.description) {
    const fixed = fixDoubleEncoded(p.description);
    if (fixed !== p.description) next.description = fixed;
  }

  if (draftPlaceholders && p.status === 'live' && /^new product$/i.test(String(p.title).trim())) {
    next.status = 'draft';
  }

  if (Object.keys(next).length) changes.push({ id: p.id, before: p, fields: next });
}

if (!changes.length) {
  console.log('Nothing to repair — catalogue is already clean.');
  process.exit(0);
}

console.log((dryRun ? 'DRY RUN — ' : 'APPLYING — ') + changes.length + ' product(s):\n');
for (const c of changes) {
  const bits = [];
  if (c.fields.title) bits.push('title: ' + JSON.stringify(c.before.title.slice(0, 60)) + ' -> ' + JSON.stringify(c.fields.title.slice(0, 60)));
  if (c.fields.description) bits.push('description: removed double-encoded entities');
  if (c.fields.status) bits.push('status: ' + c.before.status + ' -> ' + c.fields.status + '  (' + JSON.stringify(c.before.title) + ')');
  console.log('  • ' + bits.join('\n    '));
}

if (dryRun) {
  console.log('\nNothing was written. Re-run with the flag(s) but without --dry-run to apply.');
  process.exit(0);
}

const result = await api({
  action: 'saveAll',
  products: changes.map((c) => ({ id: c.id, fields: c.fields }))
});
if (result.error) {
  console.error('saveAll failed: ' + result.error);
  process.exit(1);
}
console.log('\nApplied ' + changes.length + ' product update(s): ' + JSON.stringify(result));
