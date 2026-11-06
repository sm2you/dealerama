const toUrlList = (val) => {
  let parsed = val;
  if (typeof val === 'string') {
    try { parsed = JSON.parse(val); } catch (e) { parsed = [val]; }
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed.flat(Infinity).map(u => String(u).replace(/[\[\]"']/g, '').trim()).filter(u => /^https?:\/\//i.test(u));
};

export default async (req, context) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  if (!APPS_SCRIPT_URL) return new Response(JSON.stringify({ error: 'Missing APPS_SCRIPT_URL' }), { status: 500 });

  try {
    const body = await req.json();
    
    // Send the request to Google Apps Script
    const response = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    });

    const text = await response.text();
    let data;
    try { 
      data = JSON.parse(text); 
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Apps Script error. Check deployment.' }), { status: 502 });
    }

    // Clean up products before sending to the website
    if (data.products) {
      data.products = data.products.map(p => ({
        ...p,
        id: String(p.id).replace(/'/g, '').trim(),
        images: toUrlList(p.images && p.images.length ? p.images : p.imagesJson)
      })).filter(p => p.id && p.title);
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
