import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { BASE, MODEL, OUT_DIR, ROOT, chat, saveSvg, listAssets } from './lib.mjs';

const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const json = (res, code, body) => {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { fail(new Error('invalid JSON body')); }
    });
    req.on('error', fail);
  });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json(res, 400, { error: 'messages is required' });
  try {
    json(res, 200, await chat({
      messages,
      model: body.model || MODEL,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
      maxTokens: body.max_tokens || 12000,
    }));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

async function handleSave(req, res) {
  const { svg, name } = await readBody(req);
  if (typeof svg !== 'string' || !svg.includes('<svg')) return json(res, 400, { error: 'not an SVG document' });
  try {
    const out = await saveSvg(svg, name);
    json(res, 200, { file: out.file.split(sep).pop(), bytes: out.bytes, warnings: out.warnings });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

async function handleHealth(res) {
  const out = { base: BASE, model: MODEL, ok: false, models: null, error: null };
  try {
    const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    out.ok = r.ok;
    const ids = (j.data || []).map((m) => m.id);
    out.models = ids.length;
    out.hasModel = ids.includes(MODEL);
  } catch (e) {
    out.error = String(e.message || e);
  }
  json(res, 200, out);
}

async function serveStatic(res, pathname, method = 'GET') {
  const isOut = pathname.startsWith('/out/');
  const base = isOut ? OUT_DIR : PUBLIC;
  const rel = isOut ? pathname.slice(5) : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return json(res, 400, { error: 'bad path' }); }
  const target = resolve(join(base, decoded === '/' ? '/index.html' : decoded));
  if (target !== base && !target.startsWith(base + sep)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    res.end(method === 'HEAD' ? undefined : buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && pathname === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && pathname === '/api/save') return await handleSave(req, res);
    if (req.method === 'GET' && pathname === '/api/assets') return json(res, 200, { assets: await listAssets() });
    if (req.method === 'GET' && pathname === '/api/health') return await handleHealth(res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, pathname, req.method);
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// This process died once without a stack trace: make the next silent death diagnosable.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

// A client that hangs up mid-response must not take the process down.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

await mkdir(OUT_DIR, { recursive: true });
server.listen(PORT, '127.0.0.1', () => {
  console.log(`svg-gen  http://localhost:${PORT}`);
  console.log(`model    ${MODEL}  @  ${BASE}`);
});