#!/usr/bin/env node
// Minimal MCP stdio server (JSON-RPC 2.0, newline-delimited) for svg-gen.
import { createInterface } from 'node:readline';
import {
  generate, refine, saveSvg, listAssets, readAsset, sanitizeSvg, MODEL, BASE,
} from './lib.mjs';

// piped consumers (`svg-gen list | head`) close stdout early; that is not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
}

const NAME = 'svg-gen';
const VERSION = '1.0.0';
const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'generate_svg',
    description: `Generate SVG assets from a text prompt with the local text model (${MODEL}). Returns the sanitized SVG markup and, unless save=false, the file written to out/.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the asset is. Keep it specific: subject, composition, mood.' },
        style: { type: 'string', enum: ['flat', 'line', 'duotone', 'pattern', 'logo', 'motion'], description: 'Art direction preset. "motion" adds looping CSS animation inside the SVG.' },
        size: { type: 'string', description: 'Canvas: "512", "1024", or "WxH" such as "1920x1080" or "1080x1920".' },
        palette: { type: 'string', description: 'Optional hex colors, space separated, e.g. "#0F172A #FF6B35".' },
        variants: { type: 'integer', minimum: 1, maximum: 4, description: 'How many distinct drafts to generate in parallel (default 1).' },
        model: { type: 'string', description: 'Override the model id.' },
        save: { type: 'boolean', description: 'Write the result to out/ (default true).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'refine_svg',
    description: 'Edit an existing SVG asset with a natural-language instruction. Keeps groups and structure, changes only what the instruction asks.',
    inputSchema: {
      type: 'object',
      properties: {
        svg: { type: 'string', description: 'Current SVG markup.' },
        instruction: { type: 'string', description: 'The change, e.g. "thicker strokes, swap accent to orange".' },
        name: { type: 'string', description: 'Base name for the saved file (default "refined").' },
        model: { type: 'string' },
        save: { type: 'boolean', description: 'Write the revised asset to out/ (default true).' },
      },
      required: ['svg', 'instruction'],
    },
  },
  {
    name: 'save_svg',
    description: 'Sanitize and write SVG markup to out/ (or an explicit path). Returns the file path and size.',
    inputSchema: {
      type: 'object',
      properties: {
        svg: { type: 'string' },
        name: { type: 'string', description: 'Base name for the file; slugified and timestamped.' },
        path: { type: 'string', description: 'Explicit output path instead of out/<slug>-<ts>.svg.' },
      },
      required: ['svg'],
    },
  },
  {
    name: 'list_svgs',
    description: 'List saved SVG assets in out/, newest first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_svg',
    description: 'Read one saved asset from out/ by file name.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'File name inside out/, e.g. "ikon-roket-20261027-234330.svg".' } },
      required: ['file'],
    },
  },
  {
    name: 'validate_svg',
    description: 'Check SVG markup: extraction, viewBox presence, removed unsafe markup. Does not write anything.',
    inputSchema: { type: 'object', properties: { svg: { type: 'string' } }, required: ['svg'] },
  },
];

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const errorText = (message) => ({
  content: [{ type: 'text', text: `svg-gen error: ${message}` }],
  isError: true,
});

async function callTool(name, args = {}) {
  switch (name) {
    case 'generate_svg': {
      const { variants, failures, prompt } = await generate({
        prompt: args.prompt,
        style: args.style || 'flat',
        size: args.size || '512',
        palette: args.palette || '',
        variants: args.variants || 1,
        model: args.model,
      });
      const out = [];
      for (const v of variants) {
        const saved = args.save === false ? null : await saveSvg(v.svg, args.prompt);
        out.push({
          file: saved?.file ?? null,
          bytes: saved?.bytes ?? Buffer.byteLength(v.svg),
          svg: saved?.svg ?? v.svg,
          warnings: saved?.warnings ?? [],
          ms: v.ms,
          tokens: v.usage?.completion_tokens ?? null,
        });
      }
      return text({ prompt, variants: out, failures });
    }
    case 'refine_svg': {
      const r = await refine({ svg: args.svg, instruction: args.instruction, model: args.model });
      const saved = args.save === false ? null : await saveSvg(r.svg, args.name || 'refined');
      return text({
        svg: saved?.svg ?? r.svg,
        file: saved?.file ?? null,
        bytes: saved?.bytes ?? Buffer.byteLength(r.svg),
        warnings: saved?.warnings ?? sanitizeSvg(r.svg).warnings,
        ms: r.ms,
      });
    }
    case 'save_svg': {
      const saved = await saveSvg(args.svg, args.name || 'asset', args.path);
      return text({ file: saved.file, bytes: saved.bytes, warnings: saved.warnings });
    }
    case 'list_svgs':
      return text({ dir: 'out/', assets: await listAssets() });
    case 'read_svg': {
      if (!args.file) throw new Error('file wajib diisi');
      return text({ file: args.file, svg: await readAsset(args.file) });
    }
    case 'validate_svg': {
      const { svg, warnings } = sanitizeSvg(args.svg);
      return text({ ok: true, warnings, bytes: Buffer.byteLength(svg), svg });
    }
    default:
      throw new Error(`tool tidak dikenal: ${name}`);
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: NAME, version: VERSION },
            instructions: `Local SVG asset generator. Upstream model ${MODEL} at ${BASE}. Files land in out/. Prompt in any language; keep subjects concrete.`,
          },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(name, params?.arguments || {});
          return send({ jsonrpc: '2.0', id, result });
        } catch (e) {
          return send({ jsonrpc: '2.0', id, result: errorText(e.message) });
        }
      }
      default:
        if (!isRequest) return;
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method tidak dikenal: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON tidak valid' } }); }
  void handle(msg);
});
rl.on('close', () => process.exit(0));