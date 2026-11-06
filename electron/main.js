'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const config = require('../src/core/config');
const dbmod = require('../src/core/db');
const { listVolumes } = require('../src/core/volumes');
const { setSmtpPassword } = require('../src/core/secrets');
const scheduler = require('../src/core/scheduler');
const diskcheck = require('../src/core/diskcheck');
const { appDir, volumesRoot } = require('../src/core/paths');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
let win = null;
let db = null, dbFile = null;

const scans = new Map();          // jobId -> { child, volume }   (um processo por disco, vários em paralelo)

// Mantém o Mac acordado enquanto houver verificação rodando (dormir no meio de uma leitura em exFAT é arriscado).
let awakeId = null;
function syncAwake() {
  if (!powerSaveBlocker) return;
  const need = scans.size > 0;
  try {
    if (need && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
    else if (!need && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  } catch (e) { /* ok */ }
}
const fsChecking = new Set();     // volumes com checagem de sistema de arquivos em andamento
const infoCache = new Map();      // volume -> { at, info }

const volumePath = (name) => path.join(volumesRoot(), name);
const volumeBusy = (volume) => fsChecking.has(volume) || [...scans.values()].some((s) => s.volume === volume);

function getDb() {
  const f = config.dbPath(config.load());
  if (!db || dbFile !== f) {
    if (db) { try { db.close(); } catch (e) { /* ok */ } }
    db = dbmod.open(f); dbFile = f;
  }
  return db;
}

function publicConfig() {
  const cfg = config.load();
  const scheduled = {};
  for (const j of cfg.jobs) scheduled[j.id] = scheduler.isInstalled(j);
  return { ...cfg, resolvedDbPath: config.dbPath(cfg), appDir: appDir(), volumesRoot: volumesRoot(), scheduled, platform: process.platform };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'HD Checker',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.on('closed', () => { win = null; });
}

// Roda a CLI como processo filho (a mesma que o launchd usa), com log de erros em disco.
function spawnCli(args, logName, { onLine, onExit }) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  readline.createInterface({ input: child.stdout }).on('line', (line) => { try { onLine(JSON.parse(line)); } catch (e) { /* linha não-JSON */ } });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code, signal) => {
    const clean = stderr.split('\n').filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l)).join('\n').trim();
    if (clean) {
      try {
        const dir = path.join(appDir(), 'logs'); fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `ui-${logName}.err.log`), `\n[${new Date().toISOString()}] exit=${code} ${signal || ''}\n${clean}\n`);
      } catch (e) { /* ok */ }
    }
    onExit({ code, signal, stderr: clean });
  });
  return child;
}

// ---------- Discos ----------
async function cachedInfo(name) {
  const c = infoCache.get(name);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.info;
  const info = await diskcheck.getVolumeInfo(volumePath(name)).catch(() => null);
  infoCache.set(name, { at: Date.now(), info });
  return info;
}

ipcMain.handle('volumes:list', async () => {
  const cfg = config.load();
  const d = getDb();
  const mounted = await listVolumes();
  const infos = await Promise.all(mounted.map((v) => cachedInfo(v.name)));
  const names = new Set(mounted.map((v) => v.name));
  const out = mounted.map((v, i) => ({ ...v, offline: false, info: infos[i], stats: dbmod.volumeStats(d, v.name), resume: dbmod.resumePoint(d, v.name),
    jobs: cfg.jobs.filter((j) => j.volume === v.name).map((j) => j.id), busy: volumeBusy(v.name) }));
  for (const j of cfg.jobs) {
    if (!names.has(j.volume)) {
      names.add(j.volume);
      out.push({ name: j.volume, path: volumePath(j.volume), offline: true, total: null, used: null, info: null, busy: false,
        stats: dbmod.volumeStats(d, j.volume), jobs: cfg.jobs.filter((x) => x.volume === j.volume).map((x) => x.id) });
    }
  }
  // Discos desconectados que já têm inventário no banco continuam na lista, mesmo sem job (o inventário não depende do job).
  const known = d.prepare('SELECT volume FROM files UNION SELECT volume FROM runs').all().map((r) => r.volume).filter(Boolean);
  for (const name of known) {
    if (names.has(name)) continue;
    names.add(name);
    out.push({ name, path: volumePath(name), offline: true, total: null, used: null, info: null, busy: false,
      stats: dbmod.volumeStats(d, name), resume: dbmod.resumePoint(d, name), jobs: [] });
  }
  return out;
});

// ---------- Configuração / jobs ----------
ipcMain.handle('app:version', () => require('../package.json').version);
ipcMain.handle('config:get', () => publicConfig());

ipcMain.handle('settings:save', (_e, s) => {
  const cfg = config.load();
  const smtp = { ...cfg.smtp, ...(s.smtp || {}) };
  if (s.smtpPassword) {
    setSmtpPassword(smtp.user, s.smtpPassword);
    smtp.passwordSet = true;
  }
  cfg.smtp = smtp;
  if ('dbPath' in s) cfg.dbPath = s.dbPath || null;
  config.save(cfg);
  return publicConfig();
});

ipcMain.handle('job:create', (_e, volume) => {
  const cfg = config.load();
  const job = config.newJob(volume);
  cfg.jobs.push(job);
  config.save(cfg);
  return { job, config: publicConfig() };
});

ipcMain.handle('job:save', (_e, job) => {
  const cfg = config.load();
  const i = cfg.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) cfg.jobs[i] = job; else cfg.jobs.push(job);
  config.save(cfg);
  let error = null;
  try {
    if (job.enabled) scheduler.install(job, { execPath: process.execPath, cliPath: CLI });
    else scheduler.uninstall(job);
  } catch (e) { error = 'Não consegui ' + (job.enabled ? 'agendar' : 'remover o agendamento') + ': ' + e.message; }
  return { error, config: publicConfig() };
});

ipcMain.handle('job:delete', (_e, id) => {
  const cfg = config.load();
  const job = cfg.jobs.find((j) => j.id === id);
  if (job) { try { scheduler.uninstall(job); } catch (e) { /* ok */ } }
  cfg.jobs = cfg.jobs.filter((j) => j.id !== id);
  config.save(cfg);
  return publicConfig();
});

// ---------- Execução (vários discos em paralelo) ----------
ipcMain.handle('scan:start', (_e, jobId, opts = {}) => {
  const cfg = config.load();
  const job = cfg.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: 'Job não encontrado.' };
  if (scans.has(jobId)) return { ok: false, error: 'Este job já está em execução.' };
  if (fsChecking.has(job.volume)) return { ok: false, error: `O sistema de arquivos de "${job.volume}" está sendo checado agora. Espere terminar.` };
  if ([...scans.values()].some((s) => s.volume === job.volume)) return { ok: false, error: `O disco "${job.volume}" já está sendo verificado.` };
  const args = ['run', '--job', jobId, '--json'];
  if (opts.onlyNew) args.push('--only-new');
  else if (opts.full) { args.push('--full'); if (opts.resume) args.push('--resume'); }
  const child = spawnCli(args, jobId, {
    onLine: (ev) => send('scan:event', { jobId, ...ev }),
    onExit: (r) => { scans.delete(jobId); syncAwake(); send('scan:exit', { jobId, volume: job.volume, ...r }); },
  });
  scans.set(jobId, { child, volume: job.volume });
  syncAwake();
  return { ok: true };
});

ipcMain.handle('scan:stop', (_e, jobId) => {
  if (jobId) { const s = scans.get(jobId); if (s) s.child.kill('SIGTERM'); } else scans.forEach((s) => s.child.kill('SIGTERM'));
  return true;
});
ipcMain.handle('scan:status', () => [...scans.entries()].map(([jobId, s]) => ({ jobId, volume: s.volume })));

// Execuções em segundo plano (agendadas pelo launchd ou pela linha de comando): vivem em outro processo, então o progresso vem do banco.
ipcMain.handle('scan:background', () => {
  const d = getDb();
  try { dbmod.reapStale(d); } catch (e) { /* ok */ }
  const mine = new Set([...scans.values()].map((x) => x.volume));
  return d.prepare("SELECT id, job_id, job_name, volume, started_at, heartbeat, files_total, files_hashed, bytes_read, issues FROM runs WHERE status='running'").all()
    .filter((r) => !mine.has(r.volume))
    .map((r) => ({ id: r.id, jobId: r.job_id, name: r.job_name, volume: r.volume, startedAt: r.started_at, heartbeat: r.heartbeat,
      filesDone: r.files_hashed || 0, filesTotal: r.files_total || 0, bytesRead: r.bytes_read || 0, issues: r.issues || 0 }));
});

// ---------- Relatórios ----------
ipcMain.handle('runs:list', (_e, limit = 100) => {
  const d = getDb();
  try { dbmod.reapStale(d); } catch (e) { /* ok */ }          // execuções "órfãs" (processo morto) viram "interrompidas"
  return d.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
});

function eventFilter(f = {}) {
  const where = [], args = [];
  if (f.state === 'open' || !f.state) where.push('resolved = 0');
  else if (f.state === 'resolved') where.push('resolved = 1');
  if (f.severity === 'error') where.push("severity = 'error'");
  else if (f.severity === 'warn') where.push("severity != 'error'");
  if (f.volume) { where.push('volume = ?'); args.push(f.volume); }
  if (f.runId) { where.push('run_id = ?'); args.push(f.runId); }
  if (f.kind) { where.push('kind = ?'); args.push(f.kind); }
  // Pastas (prefixos de caminho), separadas por vírgula: "2014, 2015/Viagens" -> casa com tudo dentro delas.
  const prefixes = String(f.prefix || '').split(',').map((x) => x.trim().replace(/^[\/\\]+/, '').replace(/[\/\\]+$/, '')).filter(Boolean);
  if (prefixes.length) {
    where.push('(' + prefixes.map(() => "path LIKE ? ESCAPE '\\'").join(' OR ') + ')');
    for (const x of prefixes) args.push(x.replace(/[\\%_]/g, (c) => '\\' + c) + '/%');
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

ipcMain.handle('events:list', (_e, f = {}) => {
  const { clause, args } = eventFilter(f);
  const sql = `SELECT * FROM events ${clause} ORDER BY (severity='error') DESC, at DESC LIMIT ?`;
  return getDb().prepare(sql).all(...args, f.limit || 1000);
});

// Total real (sem limite) para o badge e para avisar quando a lista está cortada.
ipcMain.handle('events:count', (_e, f = {}) => {
  const { clause, args } = eventFilter(f);
  return getDb().prepare(`SELECT COUNT(*) n FROM events ${clause}`).get(...args).n;
});

ipcMain.handle('events:resolve', (_e, { ids, action }) => {
  const d = getDb();
  const now = Date.now();
  d.exec('BEGIN');
  try {
    for (const id of ids) {
      const ev = d.prepare('SELECT * FROM events WHERE id = ?').get(id);
      if (!ev) continue;
      if (action === 'accept' && ev.kind === 'bitrot') {
        // aceita o conteúdo atual como o "novo original"
        d.prepare("UPDATE files SET hash = COALESCE(suspect_hash, hash), suspect_hash = NULL, status = 'ok', last_hashed = ? WHERE volume = ? AND path = ?").run(now, ev.volume, ev.path);
      }
      if (action === 'dismiss' && ev.kind === 'missing') {
        d.prepare('DELETE FROM files WHERE volume = ? AND path = ?').run(ev.volume, ev.path);   // sumiço reconhecido
      }
      d.prepare('UPDATE events SET resolved = 1, resolved_at = ?, resolution = ? WHERE id = ?')
        .run(now, action === 'accept' ? 'aceito pelo usuário' : 'ignorado pelo usuário', id);
      const stillOpen = d.prepare("SELECT COUNT(*) n FROM events WHERE volume = ? AND path = ? AND resolved = 0 AND severity = 'error'").get(ev.volume, ev.path).n;
      if (!stillOpen) d.prepare("UPDATE files SET status = 'ok', suspect_hash = CASE WHEN status = 'suspect' THEN NULL ELSE suspect_hash END WHERE volume = ? AND path = ? AND status = 'suspect'").run(ev.volume, ev.path);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return true;
});

// Resolve em lote os alertas "Arquivo sumiu" abertos que casam com os filtros (disco + pastas).
ipcMain.handle('events:resolveBulk', (_e, f = {}) => {
  const d = getDb();
  const { clause, args } = eventFilter({ ...f, kind: 'missing', state: 'open' });
  const rows = d.prepare(`SELECT id, volume, path FROM events ${clause}`).all(...args);
  if (f.dryRun) return { count: rows.length };
  const now = Date.now();
  d.exec('BEGIN');
  try {
    const del = d.prepare('DELETE FROM files WHERE volume = ? AND path = ?');
    const upd = d.prepare('UPDATE events SET resolved = 1, resolved_at = ?, resolution = ? WHERE id = ?');
    const why = 'apagado de propósito (em lote' + (f.prefix ? ', pasta ' + String(f.prefix).trim() : '') + ')';
    for (const r of rows) { del.run(r.volume, r.path); upd.run(now, why, r.id); }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
  return { count: rows.length };
});

ipcMain.handle('events:exportCsv', async (_e, f = {}) => {
  // Exporta o que os filtros da tela mostram (sem limite de linhas). Sem filtro explícito: só o que está aberto.
  const { clause, args } = eventFilter(f);
  const rows = getDb().prepare(`SELECT * FROM events ${clause} ORDER BY (severity='error') DESC, volume, path`).all(...args);
  const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const csv = '﻿' + ['data;disco;tipo;gravidade;arquivo;detalhe;resolvido;resolucao']
    .concat(rows.map((r) => [new Date(r.at).toISOString(), r.volume, r.kind, r.severity, r.path, r.detail, r.resolved ? 'sim' : 'não', r.resolution || ''].map(q).join(';'))).join('\n');
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: `hd_checker_${f.state === 'all' ? 'todos' : f.state === 'resolved' ? 'resolvidos' : 'abertos'}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, csv);
  return { ok: true, filePath, count: rows.length };
});

ipcMain.handle('shell:reveal', (_e, { volume, rel }) => {
  const p = path.join(volumesRoot(), volume, rel);
  if (fs.existsSync(p)) { shell.showItemInFolder(p); return { ok: true }; }
  const dir = path.dirname(p);
  if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true, note: 'O arquivo não existe mais; abri a pasta.' }; }
  return { ok: false, error: 'O arquivo e a pasta não estão acessíveis (disco conectado?).' };
});

// ---------- Saúde do disco ----------
ipcMain.handle('health:verifyFs', async (_e, volume) => {
  if (volumeBusy(volume)) return { ok: false, error: 'O disco está em uso por uma verificação ou checagem. Espere terminar (ou pare a verificação) e tente de novo.' };
  fsChecking.add(volume);
  send('health:event', { volume, kind: 'fs', type: 'start' });
  try {
    const r = await diskcheck.verifyVolume(volumePath(volume), { onLine: (line) => send('health:event', { volume, kind: 'fs', type: 'line', line }) });
    const id = dbmod.recordHealth(getDb(), { volume, kind: 'fs', status: r.status, summary: r.summary, output: r.output });
    infoCache.delete(volume);
    return { ok: true, id, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fsChecking.delete(volume);
    send('health:event', { volume, kind: 'fs', type: 'end' });
  }
});

ipcMain.handle('health:eject', async (_e, volume) => {
  if (volumeBusy(volume)) return { ok: false, error: 'Há uma verificação ou checagem em andamento neste disco. Espere terminar para ejetar.' };
  const r = await diskcheck.ejectVolume(volumePath(volume));
  infoCache.delete(volume);
  if (r.ok) return { ok: true };
  const hs = r.busy ? await diskcheck.holders(volumePath(volume)).catch(() => []) : [];
  return { ok: false, busy: !!r.busy, holders: hs, error: (r.busy ? 'Não foi possível ejetar: algum programa está usando o disco (Backblaze, Finder, Spotlight...). Feche e tente de novo.\n' : '') + r.message };
});

// Pede (SIGTERM, sem forçar) que os programas que seguram o disco terminem. A UI sempre mostra a lista e pede confirmação antes.
ipcMain.handle('health:killHolders', async (_e, volume, pids) => {
  if (volumeBusy(volume)) return { ok: false, error: 'Há uma verificação ou checagem em andamento neste disco.' };
  const r = await diskcheck.killHolders(volumePath(volume), pids);
  return { ok: true, ...r };
});

ipcMain.handle('health:list', (_e, opts = {}) => dbmod.listHealth(getDb(), opts));

// ---------- E-mail, utilidades ----------
ipcMain.handle('email:test', () => new Promise((resolve) => {
  execFile(process.execPath, [CLI, 'test-email'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message).split('\n').filter((l) => l && !/ExperimentalWarning|trace-warnings/.test(l)).join(' ').trim();
      return resolve({ ok: false, error: msg });
    }
    resolve({ ok: true });
  });
}));

ipcMain.handle('db:reveal', () => {
  const file = config.dbPath(config.load());
  if (fs.existsSync(file)) { shell.showItemInFolder(file); return { ok: true }; }
  return { ok: false, error: 'O arquivo do banco ainda não existe (rode uma verificação primeiro).' };
});


// ---------- ciclo de vida ----------
app.setName('HD Checker');
app.whenReady().then(() => {
  try { dbmod.reapStale(getDb()); } catch (e) { /* ok */ }
  // ícone no Dock também ao rodar com "npm start"
  try { if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png')); } catch (e) { /* ok */ }
  // Reaponta os agendamentos para este executável (ex.: depois de mover o app para /Applications).
  // Só reescreve o agendamento se mudou e nunca durante uma verificação (recarregar o launchd mataria a execução agendada).
  try {
    if (process.platform === 'darwin') for (const j of config.load().jobs) {
      if (!j.enabled) continue;
      const want = scheduler.buildPlist(j, { execPath: process.execPath, cliPath: CLI });
      let have = ''; try { have = fs.readFileSync(scheduler.plistPath(j), 'utf8'); } catch (e) { /* não existe */ }
      const running = getDb().prepare("SELECT 1 FROM runs WHERE volume=? AND status='running'").get(j.volume);
      if (have !== want && !running) scheduler.install(j, { execPath: process.execPath, cliPath: CLI });
    }
  } catch (e) { /* ok */ }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// No macOS, fechar a janela NÃO interrompe verificações em andamento (elas continuam; ao reabrir a janela o progresso volta).
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// Sair do app (Cmd+Q) para tudo com segurança; o que já foi lido fica salvo e a próxima execução continua.
app.on('before-quit', () => {
  scans.forEach((s) => { try { s.child.kill('SIGTERM'); } catch (e) { /* ok */ } });
});
