'use strict';
// Processos reais da CLI em paralelo: 2 discos ao mesmo tempo, mesmo disco duplicado, processo morto e progresso ao vivo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdconc-'));
const env = { ...process.env, HD_CHECKER_HOME: path.join(tmp, 'app'), HD_CHECKER_VOLUMES: path.join(tmp, 'vols'), HD_CHECKER_NO_KEYCHAIN: '1' };
Object.assign(process.env, { HD_CHECKER_HOME: env.HD_CHECKER_HOME, HD_CHECKER_VOLUMES: env.HD_CHECKER_VOLUMES, HD_CHECKER_NO_KEYCHAIN: '1' });
const CLI = path.join(__dirname, '..', 'src', 'cli.js');

const config = require('../src/core/config');
const dbmod = require('../src/core/db');

function makeVolume(name, n, size = 20000) {
  const d = path.join(env.HD_CHECKER_VOLUMES, name, 'pasta');
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `f${i}.dat`), crypto.randomBytes(size));
}
const jobs = ['A', 'B', 'C', 'D'].map((v) => ({ ...config.newJob(v), id: 'job' + v, slicePercent: 100, maxMinutes: 0, emailOn: 'never' }));
makeVolume('A', 60); makeVolume('B', 60); makeVolume('C', 100); makeVolume('D', 200);
const cfg = config.load(); cfg.jobs = jobs; config.save(cfg);

function runCli(jobId, extraEnv = {}) {
  const child = spawn(process.execPath, [CLI, 'run', '--job', jobId, '--json', '--no-email'], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal, out, err: err.split('\n').filter((l) => !/Warning|trace-warn/.test(l)).join('\n') })));
  return { child, done };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
const check = (name, fn) => { try { fn(); console.log('  ✔', name); ok++; } catch (e) { console.error('  ✘', name, '\n    ', e.message); process.exitCode = 1; } };
const q = (sql, ...a) => { const db = dbmod.open(config.dbPath(config.load())); try { return db.prepare(sql).all(...a); } finally { db.close(); } };

(async () => {
  console.log('1) Dois discos ao mesmo tempo (processos separados)');
  const slow = { HD_CHECKER_TEST_DELAY_MS: '40' };
  const [a, b] = [runCli('jobA', slow), runCli('jobB', slow)];
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const runs1 = q('SELECT * FROM runs ORDER BY id');
  const rA = runs1.find((r) => r.volume === 'A'), rB = runs1.find((r) => r.volume === 'B');
  check('os dois terminam sem erro', () => { assert.strictEqual(ra.code, 0, ra.err); assert.strictEqual(rb.code, 0, rb.err); });
  check('os dois com status ok, sem falhas de banco', () => { assert.strictEqual(rA.status, 'ok'); assert.strictEqual(rB.status, 'ok'); assert(!rA.note && !rB.note, rA.note + ' ' + rB.note); });
  check('rodaram de fato em paralelo (intervalos se sobrepõem)', () => assert(rA.started_at < rB.finished_at && rB.started_at < rA.finished_at));
  check('inventário completo dos dois discos', () => {
    assert.strictEqual(q("SELECT COUNT(*) n FROM files WHERE volume='A'")[0].n, 60);
    assert.strictEqual(q("SELECT COUNT(*) n FROM files WHERE volume='B'")[0].n, 60);
  });

  console.log('2) O mesmo disco duas vezes ao mesmo tempo');
  const [d1, d2] = [runCli('jobA', { HD_CHECKER_TEST_DELAY_MS: '80' }), runCli('jobA', { HD_CHECKER_TEST_DELAY_MS: '80' })];
  const [x1, x2] = await Promise.all([d1.done, d2.done]);
  const lastTwo = q("SELECT status, note FROM runs WHERE volume='A' ORDER BY id DESC LIMIT 2").map((r) => r.status).sort();
  check('nenhum dos dois quebra', () => { assert.strictEqual(x1.code, 0, x1.err); assert.strictEqual(x2.code, 0, x2.err); });
  check('um executa e o outro é pulado ("já em andamento")', () => assert.deepStrictEqual(lastTwo, ['ok', 'skipped']));
  check('a execução pulada explica o motivo', () => assert(/já existe uma verificação/i.test(q("SELECT note FROM runs WHERE status='skipped' AND volume='A'")[0].note)));
  check('sem arquivos duplicados no inventário', () => assert.strictEqual(q("SELECT COUNT(*) n FROM files WHERE volume='A'")[0].n, 60));

  console.log('3) Processo morto no meio (kill -9) e recuperação');
  const k = runCli('jobC', { HD_CHECKER_TEST_DELAY_MS: '100' });
  await sleep(1500);
  k.child.kill('SIGKILL');
  await k.done;
  const zombie = q("SELECT id, status, pid FROM runs WHERE volume='C' ORDER BY id DESC LIMIT 1")[0];
  check('a execução morta ficou "running" (zumbi)', () => assert.strictEqual(zombie.status, 'running'));
  const partial = q("SELECT COUNT(*) n FROM files WHERE volume='C'")[0].n;
  check('o que já tinha sido lido ficou salvo', () => assert(partial > 0 && partial < 100, 'arquivos salvos: ' + partial));
  const rr = await runCli('jobC').done;
  check('nova execução não é bloqueada pelo zumbi e conclui', () => { assert.strictEqual(rr.code, 0, rr.err); assert.strictEqual(q("SELECT status FROM runs WHERE volume='C' ORDER BY id DESC LIMIT 1")[0].status, 'ok'); });
  check('zumbi foi marcado como interrompido, com explicação', () => { const z = q('SELECT status, note FROM runs WHERE id=?', zombie.id)[0]; assert.strictEqual(z.status, 'stopped'); assert(/Encerrada inesperadamente/.test(z.note)); });
  check('retomou de onde parou (inventário completo, sem refazer tudo)', () => {
    assert.strictEqual(q("SELECT COUNT(*) n FROM files WHERE volume='C'")[0].n, 100);
    const last = q("SELECT files_new FROM runs WHERE volume='C' ORDER BY id DESC LIMIT 1")[0].files_new;
    assert(last === 100 - partial, `novos na retomada: ${last}, esperado ${100 - partial}`);
  });
  check('reapStale marca execução de PID inexistente', () => {
    const db = dbmod.open(config.dbPath(config.load()));
    db.prepare("INSERT INTO runs (job_id, job_name, volume, started_at, heartbeat, pid, status) VALUES ('x','x','Z',?,?,?,'running')").run(Date.now(), Date.now(), 999999);
    const n = dbmod.reapStale(db);
    const st = db.prepare("SELECT status FROM runs WHERE volume='Z'").get().status;
    db.close();
    assert(n >= 1 && st === 'stopped');
  });

  console.log('4) Progresso ao vivo no banco');
  const lv = runCli('jobD', { HD_CHECKER_TEST_DELAY_MS: '60' });
  let seen = null;
  for (let i = 0; i < 40 && !seen; i++) {
    await sleep(250);
    const r = q("SELECT status, files_total, files_hashed, bytes_read, pid FROM runs WHERE volume='D' ORDER BY id DESC LIMIT 1")[0];
    if (r && r.status === 'running' && r.files_hashed > 0) seen = r;
  }
  check('execução em andamento mostra números reais (não zeros)', () => { assert(seen, 'nunca viu progresso'); assert(seen.files_total === 200 && seen.bytes_read > 0 && seen.pid > 0); });
  const rl = await lv.done;
  check('termina ok', () => assert.strictEqual(rl.code, 0, rl.err));
  check('nenhuma execução ficou "running" no fim', () => assert.strictEqual(q("SELECT COUNT(*) n FROM runs WHERE status='running'")[0].n, 0));

  console.log(`\n${ok} verificações OK${process.exitCode ? ' — HÁ FALHAS' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
