/* ------------------------------------------------------------------ *
 * API layer
 * ---------------------------------------------------------------------------
 * The old version posted to /.netlify/functions/api, while index.html and
 * account.html fetched the same URL with GET and api.js answered
 * "Method Not Allowed" as plain text — which is where
 * `Unexpected token 'M', "Method Not Allowed"` came from.
 *
 * Now every page goes through these two helpers: JSON on the way out, JSON
 * expected back, a readable error when it is not, and an automatic retry on
 * the other route (/api vs /.netlify/functions/api).
 * ------------------------------------------------------------------ */
const API_ROUTES = ['/api', '/.netlify/functions/api'];
let API_BASE = null;

function apiErrorMessage(text, status) {
  const t = String(text || '').trim();
  if (/Method Not Allowed/i.test(t)) {
    return 'The API rejected this request method. Deploy the current netlify/functions/api.js and reload.';
  }
  if (/^\s*<(!doctype|html)/i.test(t)) {
    return 'The API returned an HTML page (HTTP ' + status + '). Check APPS_SCRIPT_URL and the Netlify function logs.';
  }
  if (/missing apps_script_url/i.test(t)) {
    return 'APPS_SCRIPT_URL is not set in Netlify → Site configuration → Environment variables.';
  }
  return 'Unexpected response from the server (HTTP ' + status + '). ' + t.slice(0, 160);
}

async function apiRequest(method, body) {
  const routes = API_BASE ? [API_BASE] : API_ROUTES;
  let lastError = null;

  for (const route of routes) {
    let response;
    try {
      const init = { method: method, cache: 'no-store', headers: {} };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(Object.assign({ token: TOKEN }, body));
      }
      response = await fetch(route, init);
    } catch (e) {
      lastError = new Error('Network error — could not reach ' + route + '.');
      continue;
    }

    const text = await response.text();

    if (response.status === 404) {
      // Wrong route for this deployment: try the other spelling.
      lastError = new Error('API not found at ' + route + '.');
      continue;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(apiErrorMessage(text, response.status));
    }
    if (!response.ok && !data.error) {
      throw new Error('Server error (HTTP ' + response.status + ').');
    }
    API_BASE = route;
    return data;
  }
  throw lastError || new Error('Network error.');
}

async function api(body) {
  const d = await apiRequest('POST', body);
  if (d.error) throw new Error(d.error);
  return d;
}

/** Public read used by index.html, product.html and account.html. */
async function getData() {
  const d = await apiRequest('GET', null);
  if (d.error) throw new Error(d.error);
  return d;
}

const PLACEHOLDER = 'https://placehold.co/600x600?text=No+Image';
const FONTS = ['system-ui', 'Inter', 'Poppins', 'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Raleway', 'Oswald', 'Playfair Display', 'Lora', 'Merriweather'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
const on = (v) => String(v).toLowerCase() === 'true';
let TOKEN = localStorage.getItem('gt') || '';

// ---- stars, stock bar, sanitizer ----
const stars = (r) => `<span class="stars" style="--r:${Number(r) || 0}"></span>`;
function stockBar(p, S) {
  const total = p.qty + p.sold; if (!total) return '';
  const pct = Math.round(p.sold / total * 100), low = p.qty > 0 && p.qty <= Number(S.stock_low_at || 5);
  return `<div class="mt-3"><div class="flex justify-between text-xs font-semibold mb-1"><span>${p.sold} sold</span><span style="${low ? 'color:#dc2626' : ''}">${p.qty > 0 ? 'Only ' + p.qty + ' left' : 'Sold out'}</span></div>
  <div class="h-2.5 rounded-full bg-gray-200 overflow-hidden"><div class="h-full rounded-full" style="width:${pct}%;background:${low ? '#dc2626' : S.stock_bar_color}"></div></div></div>`;
}
function sanitize(html) {
  const ok = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'B', 'STRONG', 'I', 'EM']);
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const walk = (n) => [...n.childNodes].forEach(c => {
    if (c.nodeType !== 1) return;
    if (!ok.has(c.tagName)) { if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(c.tagName)) { c.remove(); return; } walk(c); c.replaceWith(...c.childNodes); }
    else { [...c.attributes].forEach(a => c.removeAttribute(a.name)); walk(c); }
  });
  walk(doc.body.firstChild); return doc.body.firstChild.innerHTML;
}

// ---- swipe carousel (all slides are the same square size) ----
function carousel(imgs, href) {
  const list = imgs.length ? imgs : [PLACEHOLDER];
  const slide = (u) => { const im = `<img src="${esc(u)}" referrerpolicy="no-referrer" loading="lazy" draggable="false" onerror="this.onerror=null;this.src='${PLACEHOLDER}'">`; return href ? `<a class="car-slide" href="${href}">${im}</a>` : `<div class="car-slide">${im}</div>`; };
  return `<div class="car"><div class="car-track">${list.map(slide).join('')}</div>` + (list.length > 1 ? `<button class="car-b car-l" type="button" aria-label="Previous">‹</button><button class="car-b car-r" type="button" aria-label="Next">›</button><div class="car-dots">${list.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : '') + `</div>`;
}
function initCarousels(root = document, onIndex) {
  root.querySelectorAll('.car:not([data-i])').forEach(c => {
    c.dataset.i = 1;
    const t = c.querySelector('.car-track'), dots = [...c.querySelectorAll('.car-dots i')];
    const go = (d) => t.scrollBy({ left: d * t.clientWidth, behavior: 'smooth' });
    t.addEventListener('scroll', () => { const i = Math.round(t.scrollLeft / t.clientWidth); dots.forEach((x, k) => x.classList.toggle('on', k === i)); if (onIndex) onIndex(i); }, { passive: true });
    c.querySelector('.car-l')?.addEventListener('click', (e) => { e.preventDefault(); go(-1); });
    c.querySelector('.car-r')?.addEventListener('click', (e) => { e.preventDefault(); go(1); });
  });
}

// ---- theme, fonts, banner, footer ----
// ---- footer pages (open in a popup; editable in admin) ----
const DEFAULT_PAGES = [
  { title: 'Privacy Policy', body: '{business_name} collects only what we need to fill your order: your name, email, phone, shipping address and order details. Payments are handled by Stripe; we never see or store your card number.\nIf you sign in with Google, we receive your name and email address to show your orders. We only send marketing email if you agree to it (CASL).\nWe share information only with the services needed to run the store (payment processing, shipping carriers, hosting). We do not sell your information.\nUnder PIPEDA you may ask to see, correct or delete your personal information. Email {contact_email}.' },
  { title: 'Terms & Conditions', body: 'By using this site and placing an order you agree to these terms. Prices are in Canadian dollars. Applicable taxes are added where required.\nQuantities are limited. We may cancel and refund an order if an item is out of stock or a price was listed in error. Deals marked as ended cannot be purchased. Pre-orders are charged at purchase and ship on or after the listed date.\nThese terms are governed by the laws of Ontario, Canada.' },
  { title: 'Shipping', body: 'We ship within Canada. Orders usually ship in {ship_days} business days after payment. Once shipped, tracking details appear in My Orders.\nPlease double check your address at checkout, as we cannot redirect parcels once shipped.' },
  { title: 'Returns & Refunds', body: 'You may request a return within {return_days} days of delivery for unused items in original packaging. Email {contact_email} with your order number.\nRefunds go back to your original payment method once the item is received and checked. Items that arrive damaged or incorrect are refunded or replaced at no cost to you.' },
  { title: 'Contact', body: 'Questions about an order? Email {contact_email} and include your order number.' }
];
function pagesFrom(S) { try { const a = JSON.parse(S.footer_pages); if (Array.isArray(a) && a.length) return a; } catch (e) {} return DEFAULT_PAGES; }
const fill = (t, S) => String(t).replace(/\{(\w+)\}/g, (m, k) => (S[k] !== undefined && S[k] !== '') ? S[k] : '[your ' + k.replace(/_/g, ' ') + ']');
function openPage(title, body) {
  let m = document.getElementById('pgm');
  if (!m) {
    m = document.createElement('div'); m.id = 'pgm';
    m.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:16px';
    m.innerHTML = '<div style="background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:85vh;overflow:auto;padding:24px;position:relative"><button id="pgx" aria-label="Close" style="position:absolute;top:10px;right:16px;font-size:26px">✕</button><h3 id="pgt" style="font-size:1.4rem;margin:0 24px 12px 0"></h3><div id="pgb" style="font-size:.9rem;line-height:1.6"></div></div>';
    document.body.appendChild(m);
    const close = () => { m.style.display = 'none'; document.body.style.overflow = ''; };
    m.onclick = (e) => { if (e.target === m) close(); }; m.querySelector('#pgx').onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  m.querySelector('#pgt').textContent = title;
  m.querySelector('#pgb').innerHTML = String(body).split('\n').filter(x => x.trim()).map(p => `<p style="margin-bottom:.7rem">${esc(p)}</p>`).join('');
  m.style.display = 'flex'; document.body.style.overflow = 'hidden';
}

function applyTheme(s) {
  const fams = [...new Set([s.font_body, s.font_heading])].filter(f => f && f !== 'system-ui');
  if (fams.length) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?' + fams.map(f => 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + ':wght@400;700').join('&') + '&display=swap'; document.head.appendChild(l); }
  const fam = (f) => `'${f}',system-ui,sans-serif`, cols = Math.min(4, Math.max(1, Number(s.grid_cols) || 3));
  const css = document.createElement('style');
  css.textContent = `:root{--p:${s.primary_color};--a:${s.accent_color};--price:${s.price_color}}
  html{font-size:${16 * (Number(s.font_scale) || 1)}px}
  body{background:${s.bg_color};color:${s.text_color};font-family:${fam(s.font_body)}}
  nav{background:${s.nav_bg}!important}.price{color:var(--price)}
  h1,h2,h3,h4,.hd{font-family:${fam(s.font_heading)}!important;font-weight:${s.heading_weight}!important;font-style:${s.heading_style}!important;text-transform:${s.heading_transform}!important}
  .btn-p{background:var(--p);color:#fff;border-radius:${Number(s.button_radius) || 0}px!important}.btn-p:hover{opacity:.85}.btn-p:disabled{background:#9ca3af;cursor:not-allowed}
  .card{border-radius:${Number(s.card_radius) || 0}px!important;transition:transform .2s}.card:hover{transform:translateY(-4px);box-shadow:0 10px 20px rgba(0,0,0,.06)}
  .pgrid{display:grid;gap:2rem;grid-template-columns:1fr}@media(min-width:640px){.pgrid{grid-template-columns:repeat(${Math.min(cols, 2)},1fr)}}@media(min-width:1024px){.pgrid{grid-template-columns:repeat(${cols},1fr)}}
  .stars{display:inline-block;font-size:1.05em;letter-spacing:2px;background:linear-gradient(90deg,#f59e0b calc(var(--r)/5*100%),#d1d5db 0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .stars::before{content:'★★★★★'}
  .badge{position:absolute;top:12px;left:12px;padding:4px 12px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;background:var(--a);color:#fff;z-index:10}
  .car{position:relative}.car-track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}.car-track::-webkit-scrollbar{display:none}
  .car-slide{flex:0 0 100%;scroll-snap-align:center;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;background:#fff;padding:12px;box-sizing:border-box;cursor:pointer}
  .car-slide img{width:100%;height:100%;object-fit:contain;user-select:none}
  .car-b{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 1px 4px rgba(0,0,0,.3);font-size:22px;line-height:1;opacity:0;transition:.2s;z-index:5}
  .car:hover .car-b{opacity:1}.car-l{left:8px}.car-r{right:8px}
  .car-dots{position:absolute;bottom:8px;left:0;right:0;display:flex;justify-content:center;gap:5px;pointer-events:none}.car-dots i{width:7px;height:7px;border-radius:50%;background:#cbd5e1}.car-dots i.on{background:var(--p)}`;
  document.head.appendChild(css);
  const brand = document.getElementById('brand');
  if (brand) brand.innerHTML = s.logo_url ? `<img src="${esc(s.logo_url)}" alt="${esc(s.site_name)}" style="height:2.5rem" referrerpolicy="no-referrer">` : esc(s.site_name);
  const b = document.getElementById('banner');
  if (b && on(s.banner_on) && s.banner_text) { b.textContent = s.banner_text; b.style.background = s.banner_color; b.style.display = 'block'; }
  if (on(s.footer_on)) {
    const pages = pagesFrom(s), f = document.createElement('footer');
    f.className = 'border-t mt-16 py-8 px-6 text-sm text-gray-500'; f.style.background = s.footer_bg;
    f.innerHTML = `<div class="max-w-6xl mx-auto flex flex-wrap gap-x-6 gap-y-2 justify-between"><span>${esc(s.footer_text || ('© ' + new Date().getFullYear() + ' ' + s.business_name))}</span><span class="flex flex-wrap gap-x-5 gap-y-1">${pages.map((p, i) => `<button type="button" class="hover:text-black underline-offset-2 hover:underline" data-pg="${i}">${esc(p.title)}</button>`).join('')}</span></div>`;
    f.querySelectorAll('[data-pg]').forEach(btn => btn.onclick = () => { const p = pages[btn.dataset.pg]; openPage(fill(p.title, s), fill(p.body, s)); });
    document.body.appendChild(f);
  }
}

// ---- customer login (Google Sign-In: one tap, no passwords) ----
const jwt = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; } };
const authUser = () => { const p = jwt(TOKEN); return p && p.exp * 1000 > Date.now() ? p : null; };
function initAuth(S, onChange) {
  const box = document.getElementById('auth'); if (!box || !S.google_client_id) return;
  const draw = () => {
    const u = authUser();
    if (u) { box.innerHTML = `<a href="account.html" class="text-sm font-bold">${esc(u.given_name || u.email)} · My orders</a> <button id="so" class="text-xs text-gray-500 ml-2">Sign out</button>`;
      document.getElementById('so').onclick = () => { localStorage.removeItem('gt'); TOKEN = ''; draw(); onChange && onChange(); }; }
    else { box.innerHTML = '<div id="gbtn"></div>'; if (window.google && google.accounts) google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'medium' }); }
  };
  const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
  s.onload = () => { google.accounts.id.initialize({ client_id: S.google_client_id, callback: (r) => { TOKEN = r.credential; localStorage.setItem('gt', TOKEN); draw(); onChange && onChange(); } }); draw(); if (!authUser()) google.accounts.id.prompt(); };
  document.head.appendChild(s); draw();
}
