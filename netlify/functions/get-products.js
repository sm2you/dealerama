const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra }
  });

const toUrlList = (val) => {
  let parsed = val;
  if (typeof val === 'string') {
    try { parsed = JSON.parse(val); } catch (e) { parsed = [val]; }
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed
    .flat(Infinity)
    .map(u => String(u).replace(/[\[\]"']/g, '').trim())
    .filter(u => /^https?:\/\//i.test(u));
};

export default async () => {
  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  if (!APPS_SCRIPT_URL) {
    return json({ error: 'Missing APPS_SCRIPT_URL environment variable' }, 500);
  }

  try {
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'get' }),
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return json({
        error: 'Apps Script did not return JSON. Check the deployment: Execute as "Me", access "Anyone", and that APPS_SCRIPT_URL ends in /exec.',
        preview: text.slice(0, 200)
      }, 502);
    }

    if (data.error) return json({ error: data.error }, 502);

    const products = (data.products || [])
      .map(p => ({
        ...p,
        id: String(p.id).replace(/'/g, '').trim(),
        images: toUrlList(p.images && p.images.length ? p.images : p.imagesJson)
      }))
      .filter(p => p.id && p.title)
      .reverse(); // newest first

    return json({ products }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (error) {
    return json({ error: error.message }, 500);
  }
};
