# svg-gen

Aset SVG untuk motion graphics, digenerate dari prompt teks lewat model lokal OpenAI-compatible
(`http://localhost:20128/v1`, default `kn-b/deepseek-v4-1-flash`). Tiga permukaan, satu implementasi:
web UI, CLI, dan MCP server.

Tanpa dependency, tanpa build step. Runtime default: Bun 1.3. Node 24 juga jalan — semua modul
yang dipakai (`node:http`, `node:fs/promises`, `node:readline`, `fetch`) standar.

## Instalasi

```bash
cp .env.example .env     # lalu sesuaikan endpoint, model, dan API key
```

Tidak ada dependency dan tidak ada `npm install`. Bun membaca `.env` dari root proyek otomatis,
jadi `bun server.mjs`, `npm start`, `npm run cli`, dan `npm run mcp` sama-sama memakai nilai di sana.
Kalau memanggil `node` langsung, sertakan `--env-file-if-exists=.env`.

## Jalankan

```bash
bun server.mjs           # web UI  → http://localhost:5180
bun cli.mjs --help       # CLI
bun mcp.mjs              # MCP server di stdio
bun test.mjs             # 12 self-check, tanpa network
```

Alias npm: `npm start`, `npm run cli`, `npm run mcp`, `npm test`.

## Service (PM2)

```bash
pm2 start ecosystem.config.cjs   # proses `svg-gen`, interpreter bun
pm2 restart svg-gen              # dipakai setelah mengubah .env
pm2 logs svg-gen
pm2 delete svg-gen
```

`ecosystem.config.cjs` menjalankan `server.mjs` dengan `interpreter: 'bun'` dan cwd root proyek,
autorestart, maksimal 10 restart. Bun membaca `.env` dari cwd, jadi nilai env baru berlaku setelah
restart. `pm2 save` kalau mau proses ini ikut dipulihkan setelah reboot.

## Konfigurasi

| Env | Default | Keterangan |
|---|---|---|
| `OPENAI_BASE_URL` | `http://localhost:20128/v1` | Endpoint OpenAI-compatible, tanpa trailing slash |
| `OPENAI_API_KEY` | kosong | Kalau diisi, dikirim sebagai `Authorization: Bearer`; kalau kosong header tidak dikirim |
| `MODEL` | `kn-b/deepseek-v4-1-flash` | Model text-only yang menghasilkan markup SVG |
| `SVG_OUT` | `out` | Folder aset; path absolut atau relatif ke root proyek. `~` tidak diekspansi — tulis path lengkap |
| `PORT` | `5180` | Port web UI |

`.env` masuk `.gitignore`; `.env.example` yang ikut di repo.

## Web UI

Panel kiri untuk prompt, gaya, kanvas, palet, jumlah varian (1-4), dan revisi lanjutan.
Tengah pratinjau di atas kotak transparansi, dengan sakelar latar Alpha / Gelap / Terang.
Kanan sumber SVG yang bisa diedit langsung, aksi simpan/salin/unduh, dan daftar aset di folder `SVG_OUT`.

`⌘↵` / `Ctrl+↵` di kotak prompt menjalankan generate; di kotak revisi menjalankan revisi.
Setiap simpan menulis `<SVG_OUT>/<slug>-<timestamp>.svg`, dan file itu yang jadi catatan permanen.

## CLI

```bash
node cli.mjs gen "ikon roket, gaya flat, dua warna" --size 512
node cli.mjs gen "pola gelombang" --variants 3 --json
node cli.mjs refine out/ikon-roket-....svg "stroke lebih tebal, aksen oranye"
node cli.mjs gen "logo kafe" --stdout > logo.svg
node cli.mjs list
node cli.mjs check out/ikon-roket-....svg
```

Opsi lengkap: `--style flat|line|duotone|pattern|logo|motion`, `--size 512|1024|1920x1080`,
`--palette "#0F172A #FF6B35"`, `--variants 1..4`, `--model`, `--out`, `--stdout`, `--json`.
Keluaran manusia: `✓ out/file.svg  0.8 KB  4745 ms`; peringatan ke stderr, stdout tetap bersih.

## MCP

`mcp.mjs` bicara JSON-RPC 2.0 newline-delimited di stdio. Tool: `generate_svg`, `refine_svg`,
`save_svg`, `list_svgs`, `read_svg`, `validate_svg`. Semua mengembalikan JSON teks; SVG ikut di
dalamnya, jadi agent bisa langsung memakainya atau menyimpannya.

Claude Code:

```bash
claude mcp add svg-gen -- bun --env-file=/Users/kasjfulkurniawan/Projects/svg-gen/.env /Users/kasjfulkurniawan/Projects/svg-gen/mcp.mjs
```

`--env-file` ditulis eksplisit karena Bun hanya memuat `.env` dari cwd, sedangkan klien MCP kerap
meluncurkan proses dari direktori lain. Klien lain (Cursor, omp, Cline) memakai bentuk yang sama:

```json
{
  "mcpServers": {
    "svg-gen": {
      "command": "bun",
      "args": [
        "--env-file=/Users/kasjfulkurniawan/Projects/svg-gen/.env",
        "/Users/kasjfulkurniawan/Projects/svg-gen/mcp.mjs"
      ]
    }
  }
}
```

## Catatan produksi

- Model ini text-only: yang keluar markup SVG, bukan raster. Tidak ada gambar referensi yang dibaca.
- Animasi CSS/SMIL di dalam SVG hidup di browser dan di Figma, tapi **tidak** terbaca di After
  Effects/Premiere. Untuk motion graphics, impor SVG statis lalu animasikan di NLE, atau render
  animasi SVG lewat browser/ffmpeg. Gunakan gaya `motion` hanya kalau targetnya player web.
- Sanitasi: UI memakai `DOMParser` (strip `script`, `foreignObject`, `on*`, `href` eksternal);
  jalur CLI/MCP memakai filter regex setara. Semua file di folder `SVG_OUT` sudah melewati salah satunya.
- Varian jalan paralel; model bisa butuh 5-30 detik per aset.
- `max_tokens` 12000, bukan default kecil: model ini menghabiskan sebagian anggaran untuk reasoning
  sebelum markup. Dengan 4000, varian terpotong di tengah `</svg>`.
- Folder `SVG_OUT` adalah satu-satunya state. Hapus file untuk membuang aset.

## Lisensi

MIT © 2026 Kasjful Kurniawan — lihat [LICENSE](LICENSE).