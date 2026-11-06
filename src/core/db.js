'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  volume TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash TEXT,
  algo TEXT NOT NULL DEFAULT 'sha256',
  first_seen INTEGER NOT NULL,
  last_hashed INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',   -- ok | suspect | missing
  suspect_hash TEXT,
  UNIQUE (volume, path)
);
CREATE INDEX IF NOT EXISTS idx_files_vol_hashed ON files (volume, last_hashed);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files (hash, size);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  job_id TEXT, job_name TEXT, volume TEXT,
  started_at INTEGER, finished_at INTEGER,
  status TEXT,                          -- running | ok | issues | partial | stopped | skipped | error
  files_total INTEGER DEFAULT 0,
  files_hashed INTEGER DEFAULT 0,
  files_new INTEGER DEFAULT 0,
  files_changed INTEGER DEFAULT 0,
  files_missing INTEGER DEFAULT 0,
  files_moved INTEGER DEFAULT 0,
  issues INTEGER DEFAULT 0,
  bytes_read INTEGER DEFAULT 0,
  pending_new INTEGER DEFAULT 0,
  note TEXT,
  pid INTEGER,
  heartbeat INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER, volume TEXT, path TEXT,
  kind TEXT,                            -- bitrot | estrutura | ilegivel | missing
  severity TEXT,                        -- error | warn
  detail TEXT,
  at INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER,
  resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_open ON events (resolved, at);
CREATE INDEX IF NOT EXISTS idx_events_path ON events (volume, path);

CREATE TABLE IF NOT EXISTS healthchecks (
  id INTEGER PRIMARY KEY,
  volume TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- fs
  at INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- ok | warn | problems | busy | unavailable | cancelled | unknown
  summary TEXT,
  output TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_vol ON healthchecks (volume, kind, at);
`;

// Espera síncrona curta (open() é síncrono). Atomics.wait é permitido no Node/Electron main.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// O SQLite não respeita o busy_timeout em alguns casos (ex.: dois processos trocando para WAL ao mesmo tempo
// num banco novo). Nesses casos basta tentar de novo.
function withRetry(fn, tries = 60) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= tries || !/locked|busy/i.test(String(e && e.message))) throw e;
      sleepSync(40 + Math.random() * 160);
    }
  }
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 60000;');   // 1º: o timeout precisa valer já para o que vem a seguir
  withRetry(() => {
    const mode = String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase();
    if (mode !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
  });
  db.exec('PRAGMA synchronous = NORMAL;');
  withRetry(() => db.exec(SCHEMA));
  withRetry(() => {
    const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
    for (const col of ['pid', 'heartbeat']) {
      if (cols.includes(col)) continue;
      try { db.exec(`ALTER TABLE runs ADD COLUMN ${col} INTEGER`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
  });
  return db;
}

// ---- controle de execuções (uma por disco; várias discos em paralelo) ----
const STALE_HUNG_MS = 15 * 60 * 1000;   // processo vivo mas sem sinal de vida há 15 min => travado

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Marca como "interrompida" toda execução 'running' cujo processo morreu (app fechado, queda, kill -9...).
function reapStale(db) {
  const rows = db.prepare("SELECT id, pid, started_at, heartbeat FROM runs WHERE status = 'running'").all();
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    const last = r.heartbeat || r.started_at || now;
    const dead = !pidAlive(r.pid);
    const hung = now - last > STALE_HUNG_MS;
    if (dead || hung) {
      db.prepare("UPDATE runs SET status = 'stopped', finished_at = ?, note = ? WHERE id = ? AND status = 'running'")
        .run(last, dead
          ? 'Encerrada inesperadamente: o processo parou sem finalizar (app fechado, queda ou Mac desligado). O que já foi lido ficou salvo e a próxima execução continua de onde parou.'
          : 'Sem sinal de vida há mais de 15 minutos; considerada travada.', r.id);
      n++;
    }
  }
  return n;
}

// Reserva a execução de um disco de forma atômica. Se já houver uma ativa, devolve { busy }.
function acquireRun(db, job, pid = process.pid) {
  db.exec('BEGIN IMMEDIATE');
  try {
    reapStale(db);
    const live = db.prepare("SELECT id, pid, started_at FROM runs WHERE volume = ? AND status = 'running'").get(job.volume);
    if (live) { db.exec('COMMIT'); return { busy: live }; }
    const now = Date.now();
    const r = db.prepare("INSERT INTO runs (job_id, job_name, volume, started_at, heartbeat, pid, status) VALUES (?,?,?,?,?,?,'running')")
      .run(job.id, job.name, job.volume, now, now, pid);
    db.exec('COMMIT');
    return { runId: Number(r.lastInsertRowid) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ok */ }
    throw e;
  }
}

function insertFinishedRun(db, job, status, note) {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO runs (job_id, job_name, volume, started_at, finished_at, status, note, pid) VALUES (?,?,?,?,?,?,?,?)')
    .run(job.id, job.name, job.volume, now, now, status, note, process.pid).lastInsertRowid);
}

// Estatísticas de cobertura de um volume (quanto do disco foi verificado e quando).
function volumeStats(db, volume) {
  const now = Date.now();
  const day = 86400000;
  const r = db.prepare(`
    SELECT COUNT(*) AS files,
           COALESCE(SUM(size),0) AS bytes,
           SUM(CASE WHEN last_hashed IS NULL THEN 1 ELSE 0 END) AS never,
           SUM(CASE WHEN last_hashed >= ? THEN 1 ELSE 0 END) AS d30,
           SUM(CASE WHEN last_hashed >= ? THEN 1 ELSE 0 END) AS d90,
           SUM(CASE WHEN last_hashed >= ? THEN 1 ELSE 0 END) AS d365,
           MIN(last_hashed) AS oldest
    FROM files WHERE volume = ? AND status != 'missing'`).get(now - 30 * day, now - 90 * day, now - 365 * day, volume);
  const open = db.prepare('SELECT COUNT(*) AS n FROM events WHERE volume = ? AND resolved = 0 AND severity = \'error\'').get(volume).n;
  const openWarn = db.prepare('SELECT COUNT(*) AS n FROM events WHERE volume = ? AND resolved = 0 AND severity != \'error\'').get(volume).n;
  const last = db.prepare('SELECT id, started_at, finished_at, status FROM runs WHERE volume = ? ORDER BY id DESC LIMIT 1').get(volume) || null;
  const lastFs = db.prepare("SELECT at, status, summary FROM healthchecks WHERE volume = ? AND kind = 'fs' AND status IN ('ok','problems') ORDER BY at DESC LIMIT 1").get(volume) || null;
  const newSinceFs = lastFs ? db.prepare('SELECT COUNT(*) AS n FROM files WHERE volume = ? AND first_seen > ?').get(volume, lastFs.at).n : null;
  return {
    lastFsCheck: lastFs, newSinceFsCheck: newSinceFs,
    files: r.files, bytes: r.bytes, never: r.never || 0,
    d30: r.d30 || 0, d90: r.d90 || 0, d365: r.d365 || 0,
    oldestVerified: r.oldest || null, openErrors: open, openWarnings: openWarn, lastRun: last,
  };
}

function recordHealth(db, { volume, kind, status, summary, output }) {
  return Number(db.prepare('INSERT INTO healthchecks (volume, kind, at, status, summary, output) VALUES (?,?,?,?,?,?)')
    .run(volume, kind, Date.now(), status, summary || null, (output || '').slice(0, 200000)).lastInsertRowid);
}

function listHealth(db, { volume, limit = 30 } = {}) {
  return volume
    ? db.prepare('SELECT * FROM healthchecks WHERE volume = ? ORDER BY at DESC LIMIT ?').all(volume, limit)
    : db.prepare('SELECT * FROM healthchecks ORDER BY at DESC LIMIT ?').all(limit);
}


// Ponto de retomada da "Verificação completa": se as últimas verificações completas do disco foram interrompidas
// (disco desconectado, parada manual, limite...), devolve de quando elas começaram; arquivos lidos desde então já estão
// verificados e podem ser pulados. Devolve null se a última verificação completa terminou ou se nunca houve uma.
function resumePoint(db, volume) {
  const runs = db.prepare("SELECT id, started_at, finished_at, status, files_hashed, bytes_read FROM runs WHERE volume = ? AND job_name LIKE '%(completa%' AND status != 'skipped' ORDER BY started_at DESC LIMIT 20").all(volume);
  const cut = [];
  for (const r of runs) {
    if (r.status === 'running') return null;              // há uma em andamento
    if (r.status === 'ok' || r.status === 'issues') break;  // terminou: nada a retomar antes dela
    cut.push(r);                                           // stopped | partial | error
  }
  if (!cut.length) return null;
  const since = cut[cut.length - 1].started_at;
  const done = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM files WHERE volume = ? AND status != 'missing' AND last_hashed >= ?").get(volume, since);
  const todo = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM files WHERE volume = ? AND status != 'missing' AND (last_hashed IS NULL OR last_hashed < ?)").get(volume, since);
  return { since, runs: cut.length, lastRunAt: cut[0].started_at, doneFiles: done.n, doneBytes: done.b, todoFiles: todo.n, todoBytes: todo.b };
}

module.exports = { resumePoint, recordHealth, listHealth, open, volumeStats, acquireRun, insertFinishedRun, reapStale, pidAlive };
