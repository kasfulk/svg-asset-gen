#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  generate, refine, saveSvg, listAssets, sanitizeSvg, parseSize, MODEL, OUT_DIR,
} from './lib.mjs';

const HELP = `svg-gen — aset SVG dari teks, lewat model OpenAI-compatible lokal

Pemakaian:
  svg-gen gen <prompt> [opsi]        generate aset, simpan ke ${OUT_DIR}
  svg-gen refine <file.svg> <instruksi> [opsi]
  svg-gen list [--json]              daftar aset tersimpan
  svg-gen check <file.svg>           validasi + sanitasi, tanpa menulis

Opsi gen/refine:
  --style flat|line|duotone|pattern|logo|motion   default flat
  --size 512 | 1920x1080                          default 512
  --palette "#0F172A #FF6B35"
  --variants 1..4                                 default 1
  --model <id>                                    default ${MODEL}
  --out <path.svg>                                tulis ke path eksplisit
  --stdout                                        cetak SVG, jangan simpan
  --json                                          keluaran JSON

Contoh:
  svg-gen gen "ikon roket, flat, dua warna" --size 512
  svg-gen gen "pola gelombang" --variants 3 --json
  svg-gen refine out/ikon.svg "stroke lebih tebal, warna oranye"
  svg-gen gen "logo kafe" --stdout > logo.svg
`;

// piped consumers (`svg-gen list | head`) close stdout early; that is not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
}

const COMMANDS = new Set(['gen', 'refine', 'list', 'check', 'help', '--help', '-h']);

function parseFlags(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdout' || a === '--json' || a === '--help' || a === '-h') { flags[a.replace(/^--?/, '')] = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) fail(`opsi ${a} butuh nilai`);
      flags[key] = value;
      continue;
    }
    positional.push(a);
  }
  return { flags, positional };
}

function fail(msg, code = 1) {
  process.stderr.write(`svg-gen: ${msg}\n`);
  process.exit(code);
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

async function cmdGen(flags, positional) {
  const prompt = positional.join(' ').trim();
  if (!prompt) fail('prompt kosong. Contoh: svg-gen gen "ikon roket"');
  const variants = Number(flags.variants || 1);
  if (variants > 1 && flags.out) fail('--out hanya untuk satu varian; hapus --variants atau --out');

  const { variants: results, failures, prompt: built } = await generate({
    prompt,
    style: flags.style || 'flat',
    size: flags.size || '512',
    palette: flags.palette || '',
    variants,
    model: flags.model,
  });

  const saved = [];
  for (const r of results) {
    if (flags.stdout) { saved.push({ ...r, warnings: sanitizeSvg(r.svg).warnings }); continue; }
    const out = await saveSvg(r.svg, prompt, flags.out ? resolve(flags.out) : null);
    saved.push({ ...r, file: out.file, bytes: out.bytes, svg: out.svg, warnings: out.warnings });
  }

  if (flags.stdout) {
    for (const s of saved) process.stdout.write(s.svg + (saved.length > 1 ? '\n' : ''));
    return;
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({
      prompt: built,
      variants: saved.map((s) => ({ file: s.file, bytes: s.bytes, svg: s.svg, ms: s.ms, usage: s.usage, warnings: s.warnings })),
      failures,
    }, null, 2) + '\n');
    return;
  }
  for (const s of saved) {
    process.stdout.write(`✓ ${s.file}  ${kb(s.bytes)}  ${s.ms} ms${s.usage?.completion_tokens ? `  ${s.usage.completion_tokens} tok` : ''}\n`);
    for (const w of s.warnings) process.stderr.write(`  ! ${w}\n`);
  }
  for (const f of failures) process.stderr.write(`  ! varian gagal: ${f}\n`);
}

async function cmdRefine(flags, positional) {
  const [file, ...rest] = positional;
  if (!file) fail('butuh path file SVG. Contoh: svg-gen refine out/a.svg "lebih tebal"');
  const instruction = rest.join(' ').trim();
  if (!instruction) fail('instruksi revisi kosong');
  const source = await readFile(resolve(file), 'utf8').catch(() => fail(`tidak bisa membaca ${file}`));
  const r = await refine({ svg: source, instruction, model: flags.model });

  if (flags.stdout) { process.stdout.write(r.svg + '\n'); return; }
  const stem = basename(file, '.svg').replace(/(-\d{8}-\d{6}|-\d{4})$/, '');
  const out = await saveSvg(r.svg, stem + '-rev', flags.out ? resolve(flags.out) : null);
  if (flags.json) {
    process.stdout.write(JSON.stringify({ file: out.file, bytes: out.bytes, svg: out.svg, ms: r.ms, warnings: out.warnings }, null, 2) + '\n');
    return;
  }
  process.stdout.write(`✓ ${out.file}  ${kb(out.bytes)}  ${r.ms} ms\n`);
  for (const w of out.warnings) process.stderr.write(`  ! ${w}\n`);
}

async function cmdList(flags) {
  const assets = await listAssets();
  if (flags.json) { process.stdout.write(JSON.stringify({ assets }, null, 2) + '\n'); return; }
  if (!assets.length) { process.stdout.write('(belum ada aset di ${OUT_DIR})\n'); return; }
  for (const a of assets) process.stdout.write(`${a.file}  ${kb(a.bytes)}\n`);
}

async function cmdCheck(positional) {
  const file = positional[0];
  if (!file) fail('butuh path file SVG');
  const source = await readFile(resolve(file), 'utf8').catch(() => fail(`tidak bisa membaca ${file}`));
  try {
    const { svg, warnings } = sanitizeSvg(source);
    const vb = svg.match(/viewBox\s*=\s*["']([^"']+)["']/i);
    process.stdout.write(`ok  ${file}  viewBox ${vb ? vb[1] : '-'}  ${kb(Buffer.byteLength(svg))}\n`);
    for (const w of warnings) process.stdout.write(`! ${w}\n`);
  } catch (e) {
    fail(`tidak valid: ${e.message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = COMMANDS.has(argv[0]) ? argv[0] : 'gen';
  const rest = COMMANDS.has(argv[0]) ? argv.slice(1) : argv;
  const { flags, positional } = parseFlags(rest);

  if (command === 'help' || command === '--help' || command === '-h' || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    if (command === 'gen') await cmdGen(flags, positional);
    else if (command === 'refine') await cmdRefine(flags, positional);
    else if (command === 'list') await cmdList(flags);
    else if (command === 'check') await cmdCheck(positional);
  } catch (e) {
    fail(e.message);
  }
}

main();