// PM2: proses `svg-gen` dijalankan pakai Bun. Bun membaca .env sendiri dari cwd,
// jadi OPENAI_BASE_URL / MODEL / SVG_OUT / PORT di .env otomatis berlaku.
module.exports = {
  apps: [{
    name: 'svg-gen',
    script: 'server.mjs',
    interpreter: 'bun',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    time: true,
  }],
};