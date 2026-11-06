const API = '/.netlify/functions/api';
const PLACEHOLDER = 'https://placehold.co/600x600?text=No+Image';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const on = (v) => String(v).toLowerCase() === 'true';

async function api(body) {
  const r = await fetch(API, { method: 'POST', body: JSON.stringify(body) });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const stars = (r) => `<span class="stars" style="--r:${Number(r) || 0}"></span>`;

function stockBar(p) {
  const total = p.qty + p.sold;
  if (!total) return '';
  const pct = Math.round(p.sold / total * 100);
  return `<div class="mt-3"><div class="flex justify-between text-xs font-semibold mb-1"><span>${p.sold} sold</span><span>${p.qty > 0 ? 'Only ' + p.qty + ' left' : 'Sold out'}</span></div>
  <div class="h-2.5 rounded-full bg-gray-200 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${pct >= 80 ? '#ef4444' : 'var(--a)'}"></div></div></div>`;
}

function sanitize(html) {
  const ok = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM']);
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const walk = (n) => [...n.childNodes].forEach(c => {
    if (c.nodeType !== 1) return;
    if (!ok.has(c.tagName)) {
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(c.tagName)) { c.remove(); return; }
      walk(c); c.replaceWith(...c.childNodes);
    } else { [...c.attributes].forEach(a => c.removeAttribute(a.name)); walk(c); }
  });
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

function applyTheme(s) {
  const css = document.createElement('style');
  css.textContent = `:root{--p:${s.primary_color};--a:${s.accent_color}}
  html{font-size:${16 * (Number(s.font_scale) || 1)}px}
  body{background:#f9f9f9;font-family:system-ui,sans-serif}
  .btn-p{background:var(--p);color:#fff}.btn-p:hover{opacity:.85}.btn-p:disabled{background:#9ca3af;cursor:not-allowed}
  .stars{display:inline-block;font-size:1.05em;letter-spacing:2px;background:linear-gradient(90deg,#f59e0b calc(var(--r)/5*100%),#d1d5db 0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .stars::before{content:'★★★★★'}
  .badge{position:absolute;top:12px;left:12px;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;background:var(--a);color:#fff;z-index:10}
  .card{transition:transform .2s}.card:hover{transform:translateY(-4px);box-shadow:0 10px 20px rgba(0,0,0,.06)}`;
  document.head.appendChild(css);
  const brand = document.getElementById('brand');
  if (brand) brand.innerHTML = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="${esc(s.site_name)}" style="height:2.5rem" referrerpolicy="no-referrer">` : esc(s.site_name);
  const b = document.getElementById('banner');
  if (b && on(s.banner_on) && s.banner_text) { b.textContent = s.banner_text; b.style.background = s.banner_color; b.style.display = 'block'; }
}
