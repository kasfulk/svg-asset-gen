import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(ROOT, process.env.SVG_OUT || 'out');
export const BASE = (process.env.OPENAI_BASE_URL || 'http://localhost:20128/v1').replace(/\/$/, '');
export const KEY = process.env.OPENAI_API_KEY || '';
export const MODEL = process.env.MODEL || 'kn-b/deepseek-v4-1-flash';

export const SYSTEM = `You generate SVG assets for motion-graphics video production.

Reply with exactly one <svg> element and nothing else: no prose, no markdown fences, no XML declaration, no comments.

Hard rules:
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H" width="W" height="H">.
- Fully self-contained: no <script>, no <foreignObject>, no external images, fonts, or url() references. Only inline vector shapes, gradients, clipPaths, masks and filters.
- Transparent background: never cover the whole canvas with an opaque rect.
- Every coordinate stays inside the viewBox with a small margin.
- Group related geometry in <g id="meaningful-name"> so the asset can be animated later.
- Flat vector style: strong silhouettes, clean curves, consistent stroke widths, readable at 64px.
- Palette: honor requested colors; otherwise three colors plus neutrals, high contrast.
- Text only when explicitly requested, and only with a generic font stack such as font-family="Helvetica, Arial, sans-serif".
- Do not ask questions. If the brief is vague, commit to one strong direction.

When animation is requested, animate with CSS @keyframes inside <style> or SMIL (<animate>, <animateTransform>), with seamless loops. Otherwise output a static asset.`;

export const STYLE_HINTS = {
  flat: 'Gaya: flat vector, bidang warna solid, bentuk tegas, tanpa gradien rumit.',
  line: 'Gaya: ikon garis, stroke seragam, tanpa isi bidang kecuali aksen kecil.',
  duotone: 'Gaya: ilustrasi dua warna dengan bentuk organik dan satu gradien halus.',
  pattern: 'Gaya: pola geometris berulang yang bisa di-tile tanpa elemen dominan tunggal.',
  logo: 'Gaya: logo mark sederhana, satu ide visual, siluet tegas, tanpa detail kecil.',
  motion: 'Siap animasi: pecah ke grup ber-id, tambahkan animasi CSS loop halus lewat @keyframes di dalam <style>.',
};

export function parseSize(value = '512') {
  const pair = String(value).toLowerCase().split('x').map(Number);
  if (pair.length === 2 && pair.every((n) => Number.isFinite(n) && n > 0)) return { w: pair[0], h: pair[1] };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`label size tidak valid: ${value} (pakai 512 atau 1920x1080)`);
  return { w: n, h: n };
}

export function buildUserPrompt({ prompt, style = 'flat', size = '512', palette = '' }) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt kosong');
  const { w, h } = parseSize(size);
  const lines = [
    String(prompt).trim(),
    `Kanvas ${w}x${h} px, viewBox "0 0 ${w} ${h}".`,
    STYLE_HINTS[style] || STYLE_HINTS.flat,
  ];
  if (palette && String(palette).trim()) lines.push(`Gunakan palet ini: ${String(palette).trim()}.`);
  lines.push('Latar transparan, tanpa teks kecuali diminta secara eksplisit.');
  return lines.join('\n');
}

export function extractSvg(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('<svg');
  if (start < 0) throw new Error('model tidak mengembalikan elemen <svg>');
  const end = t.lastIndexOf('</svg>');
  if (end < 0) throw new Error('keluaran terpotong: tidak ada </svg>');
  return t.slice(start, end + 6);
}

// Ceiling: regex-level filter, not a DOM sanitizer. The web UI does the AST-based pass;
// this one protects files written by the CLI/MCP path.
export function sanitizeSvg(input) {
  const extracted = extractSvg(input);
  const warnings = [];
  const cleaned = extracted
    .replace(/<(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|foreignObject|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("|')(?!#|data:image\/)[^"']*\1/gi, '');
  if (cleaned !== extracted) warnings.push('markup tidak aman dihapus (script/event handler/href eksternal)');
  if (!/viewBox\s*=/i.test(cleaned)) warnings.push('tanpa viewBox');
  return { svg: cleaned, warnings };
}

function parseUpstream(text) {
  try { return JSON.parse(text); } catch { /* trailing `data: [DONE]` */ }
  const end = text.lastIndexOf('}');
  if (end > 0) { try { return JSON.parse(text.slice(0, end + 1)); } catch { /* fall through */ } }
  throw new Error('upstream bukan JSON: ' + text.slice(0, 200));
}

export async function chat({ messages, model = MODEL, temperature = 0.7, maxTokens = 12000, timeoutMs = 240_000 }) {
  const started = Date.now();
  const payload = {
    model: model || MODEL,
    messages: [{ role: 'system', content: SYSTEM },
      ...messages.filter((m) => m && m.role && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }))],
    temperature,
    max_tokens: maxTokens,
  };

  let res;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`upstream tidak terjangkau di ${BASE}: ${e.message || e}`);
    err.status = 502;
    throw err;
  }

  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}: ${raw.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const data = parseUpstream(raw);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    const err = new Error('model tidak mengembalikan konten');
    err.status = 502;
    throw err;
  }
  return { content, ms: Date.now() - started, usage: data.usage || null, model: data.model || payload.model };
}

export const slug = (s) =>
  String(s || 'asset').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'asset';

export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

export async function saveSvg(svg, name = 'asset', file = null) {
  const { svg: clean, warnings } = sanitizeSvg(svg);
  const bytes = Buffer.byteLength(clean);
  if (bytes > 2 * 1024 * 1024) throw new Error('svg melebihi 2MB');
  if (file) {
    await mkdir(dirname(resolve(file)), { recursive: true });
    await writeFile(resolve(file), clean, 'utf8');
    return { file: resolve(file), bytes: bytes, svg: clean, warnings };
  }
  await mkdir(OUT_DIR, { recursive: true });
  // Two variants generated in the same second slug to the same name: never clobber an existing asset.
  const base = `${slug(name)}-${stamp()}`;
  let target = join(OUT_DIR, `${base}.svg`);
  for (let n = 2; ; n++) {
    try {
      await writeFile(target, clean, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' || n > 99) throw e;
      target = join(OUT_DIR, `${base}-${n}.svg`);
    }
  }
  return { file: target, bytes, svg: clean, warnings };
}

export async function listAssets(limit = 200) {
  await mkdir(OUT_DIR, { recursive: true });
  const names = (await readdir(OUT_DIR)).filter((n) => n.endsWith('.svg'));
  const assets = await Promise.all(names.map(async (file) => {
    const s = await stat(join(OUT_DIR, file));
    return { file, bytes: s.size, mtime: s.mtimeMs };
  }));
  return assets.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export async function readAsset(file) {
  const name = String(file).replace(/^.*[\\/]/, '');
  try {
    return await readFile(join(OUT_DIR, name), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`aset tidak ditemukan di out/: ${name}`);
    throw e;
  }
}

/** Generate N variants in parallel; returns { variants: [{svg, ms, usage, model}], failures: [msg] } */
export async function generate({ prompt, style, size, palette, variants = 1, model, temperature = 0.7 }) {
  const base = buildUserPrompt({ prompt, style, size, palette });
  const n = Math.min(4, Math.max(1, Number(variants) || 1));
  const jobs = Array.from({ length: n }, (_, i) => {
    const content = n > 1
      ? `${base}\n\nVarian ${i + 1} dari ${n}: komposisi yang jelas berbeda dari varian lain.`
      : base;
    return chat({ messages: [{ role: 'user', content }], model, temperature })
      .then((r) => ({ ...r, svg: extractSvg(r.content) }));
  });
  const settled = await Promise.allSettled(jobs);
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failures = settled.filter((s) => s.status === 'rejected').map((s) => String(s.reason?.message || s.reason));
  if (!ok.length) throw new Error(failures[0] || 'gagal generate');
  return { variants: ok, failures, prompt: base };
}

export async function refine({ svg, instruction, model, temperature = 0.6 }) {
  if (!instruction || !String(instruction).trim()) throw new Error('instruction kosong');
  const { svg: clean } = sanitizeSvg(svg);
  const r = await chat({
    messages: [
      { role: 'user', content: 'Ini aset SVG saat ini. Pertahankan id grup dan struktur, ubah hanya sesuai instruksi berikut.' },
      { role: 'assistant', content: clean },
      { role: 'user', content: String(instruction).trim() },
    ],
    model,
    temperature,
  });
  return { ...r, svg: extractSvg(r.content) };
}