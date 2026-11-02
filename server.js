// Zero-dependency server: serves the UI and proxies screenshots to Gemini.
// The API key stays server-side; never ship it to the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = process.env.PORT || 3000;
// Tried in order; the next one is used only when the previous is overloaded or times out.
const MODELS = [process.env.GEMINI_MODEL_1, process.env.GEMINI_MODEL_2].filter(Boolean);
if (!MODELS.length) MODELS.push('gemini-3.1-flash-lite');
const KEY = process.env.GEMINI_API_KEY;
const MAX_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          variant: { type: 'STRING', description: 'Attributes like color, size; empty if none' },
          unit_price: { type: 'NUMBER', description: 'Unit price in ARS as a plain number' },
          quantity: { type: 'INTEGER' },
        },
        required: ['title', 'variant', 'unit_price', 'quantity'],
      },
    },
    shipping_type: { type: 'STRING' },
    recipient_name: { type: 'STRING' },
    street: { type: 'STRING' },
    postal_code: { type: 'STRING' },
    city: { type: 'STRING' },
    province: { type: 'STRING' },
  },
  required: ['items', 'shipping_type', 'recipient_name', 'street', 'postal_code', 'city', 'province'],
};

const PROMPT = `This is a screenshot of a MercadoLibre (Argentina) sale.
Extract the sold items and the shipping data. Prices use Argentine format:
"." is the thousands separator and "," the decimal one, so "$ 59.999" is 59999.
Use an empty string for any field not visible. Do not invent data.`;

async function extract(mimeType, base64) {
  for (const model of MODELS) {
    try {
      return await callModel(model, mimeType, base64);
    } catch (err) {
      if (!err.overloaded) throw err;
      console.warn(`${model}: ${err.message}`);
    }
  }
  throw new Error('Gemini está saturado en este momento. Probá de nuevo en unos minutos.');
}

const overloaded = (message) => Object.assign(new Error(message), { overloaded: true });

async function callModel(model, mimeType, base64) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 },
      }),
      // ponytail: fixed 20s cap per model; Gemini under load can hang ~60s and the UI would look frozen.
      signal: AbortSignal.timeout(20_000),
    },
  ).catch((err) => {
    throw err.name === 'TimeoutError' ? overloaded('timed out after 20s') : err;
  });
  const body = await res.json();
  if (res.status === 503 || res.status === 429) throw overloaded(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(body.error?.message || `Gemini HTTP ${res.status}`);
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');
  return JSON.parse(text);
}

function send(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const html = (await readFile(new URL('./index.html', import.meta.url), 'utf8')).replace('__MODELS__', MODELS.join(','));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && req.url === '/api/extract') {
      if (!KEY) return send(res, 500, { error: 'GEMINI_API_KEY is not set' });
      const mimeType = req.headers['content-type'];
      if (!MIME_TYPES.includes(mimeType)) return send(res, 415, { error: 'Only JPEG, PNG or WEBP images' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) return send(res, 413, { error: 'Image larger than 10MB' });
        chunks.push(chunk);
      }
      return send(res, 200, await extract(mimeType, Buffer.concat(chunks).toString('base64')));
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 502, { error: err.message });
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT} (models: ${MODELS.join(' → ')})`));
