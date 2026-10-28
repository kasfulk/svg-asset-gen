// Runnable self-check. No framework: node test.mjs (or npm test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// keep test writes out of the real asset dir; must be set before the module reads it
process.env.SVG_OUT = mkdtempSync(join(tmpdir(), 'svggen-test-'));
const { extractSvg, sanitizeSvg, parseSize, buildUserPrompt, slug, saveSvg, listAssets } = await import('./lib.mjs');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

await check('extractSvg unwraps markdown fences and prose', () => {
  const raw = 'Here you go:\n```svg\n<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>\n```\nEnjoy.';
  assert.equal(extractSvg(raw), '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
});

await check('extractSvg rejects truncated output', () => {
  assert.throws(() => extractSvg('<svg viewBox="0 0 8 8"><rect'), /terpotong/);
  assert.throws(() => extractSvg('no markup here'), /<svg>/);
});

await check('sanitizeSvg strips scripts, handlers and external hrefs, keeps fragments', () => {
  const dirty = `<svg viewBox="0 0 10 10" onload="boom()">
    <script>alert(1)</script>
    <foreignObject><div/></foreignObject>
    <a href="https://evil.example/x"><rect width="10" height="10" onclick="boom()"/></a>
    <use href="#shape"/><image href="data:image/png;base64,AA"/>
  </svg>`;
  const { svg, warnings } = sanitizeSvg(dirty);
  assert.ok(!/script/i.test(svg), 'script survives');
  assert.ok(!/onload|onclick/i.test(svg), 'event handler survives');
  assert.ok(!/https:/.test(svg), 'external href survives');
  assert.ok(!/foreignObject/.test(svg), 'foreignObject survives');
  assert.ok(svg.includes('href="#shape"'), 'fragment ref lost');
  assert.ok(svg.includes('data:image/png'), 'data uri image lost');
  assert.equal(warnings.length, 1);
});

await check('sanitizeSvg warns about a missing viewBox', () => {
  const { warnings } = sanitizeSvg('<svg width="10" height="10"><rect/></svg>');
  assert.deepEqual(warnings, ['tanpa viewBox']);
});

await check('parseSize accepts square and WxH, rejects garbage', () => {
  assert.deepEqual(parseSize('512'), { w: 512, h: 512 });
  assert.deepEqual(parseSize('1920x1080'), { w: 1920, h: 1080 });
  assert.throws(() => parseSize('big'), /tidak valid/);
  assert.throws(() => parseSize('0'), /tidak valid/);
});

await check('buildUserPrompt carries canvas, style and palette', () => {
  const p = buildUserPrompt({ prompt: 'ikon kunci', style: 'line', size: '1920x1080', palette: '#111 #f60' });
  assert.ok(p.startsWith('ikon kunci'));
  assert.ok(p.includes('viewBox "0 0 1920 1080"'));
  assert.ok(p.includes('ikon garis'));
  assert.ok(p.includes('#111 #f60'));
  assert.throws(() => buildUserPrompt({ prompt: '   ' }), /prompt kosong/);
});

await check('slug is filename safe', () => {
  assert.equal(slug('Ikon Roket, 2 warna!'), 'ikon-roket-2-warna');
  assert.equal(slug('***'), 'asset');
});

await check('saveSvg never overwrites an asset from the same second', async () => {
  const svg = '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>';
  const a = await saveSvg(svg, 'same name');
  const b = await saveSvg(svg, 'same name');
  assert.notEqual(a.file, b.file);
  assert.equal((await listAssets()).length, 2);
  const names = readdirSync(process.env.SVG_OUT);
  assert.ok(names.some((n) => /-2\.svg$/.test(n)), 'expected a -2 suffix');
});

/* MCP protocol round-trip without touching the model. */
const child = spawn(process.execPath, ['mcp.mjs'], { cwd: import.meta.dirname, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = new Map();
let buffer = '';
child.stdout.on('data', (d) => {
  buffer += d.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    replies.get(msg.id)?.(msg);
  }
});
const rpc = (id, method, params) => new Promise((resolve, reject) => {
  replies.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error('timeout ' + method)), 10_000).unref();
});

const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
assert.equal(init.result.serverInfo.name, 'svg-gen');
assert.ok(init.result.capabilities.tools);
passed++; console.log('ok  mcp initialize');

const listed = await rpc(2, 'tools/list', {});
const names = listed.result.tools.map((t) => t.name).sort();
assert.deepEqual(names, ['generate_svg', 'list_svgs', 'read_svg', 'refine_svg', 'save_svg', 'validate_svg']);
passed++; console.log('ok  mcp tools/list');

const called = await rpc(3, 'tools/call', { name: 'validate_svg', arguments: { svg: '<svg viewBox="0 0 4 4"><script>x</script><rect width="4" height="4"/></svg>' } });
const payload = JSON.parse(called.result.content[0].text);
assert.equal(payload.ok, true);
assert.ok(!payload.svg.includes('script'));
assert.ok(payload.warnings.length === 1);
passed++; console.log('ok  mcp tools/call validate_svg');

const failed = await rpc(4, 'tools/call', { name: 'nope', arguments: {} });
assert.equal(failed.result.isError, true);
passed++; console.log('ok  mcp unknown tool isError');

child.kill();
console.log(`\n${passed} checks passed`);