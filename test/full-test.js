'use strict';
// "--full" lê 100% do disco e ignora fatia e limite de horário do job; sem a flag (agendado) vale a fatia do job.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { spawnSync } = require('child_process');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hdfull-'));
const env = { ...process.env, HD_CHECKER_HOME: home, HD_CHECKER_VOLUMES: path.join(home, 'vols'), HD_CHECKER_NO_KEYCHAIN: '1' };
const vol = path.join(env.HD_CHECKER_VOLUMES, 'Fotos'); fs.mkdirSync(vol, { recursive: true });
const jpg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from([0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0]), Buffer.from(crypto.randomBytes(4000).map((b) => ((b | 1) === 0xFF ? 0x7F : b | 1))), Buffer.from([0xFF, 0xD9])]);
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(vol, `f${i}.jpg`), jpg());
process.env.HD_CHECKER_HOME = home; process.env.HD_CHECKER_VOLUMES = env.HD_CHECKER_VOLUMES; process.env.HD_CHECKER_NO_KEYCHAIN = '1';
const config = require('../src/core/config');
const cfg = config.load(); const job = { ...config.newJob('Fotos'), slicePercent: 12.5, maxMinutes: 1, emailOn: 'never' }; cfg.jobs = [job]; config.save(cfg);
let failed = 0; const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };
const cli = (...a) => { const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'run', '--job', job.id, '--json', '--no-email', ...a], { env, encoding: 'utf8' }); return r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); };
const plan = (evs) => evs.find((e) => e.type === 'plan');
cli();                                                           // 1ª execução: cataloga tudo (arquivos novos)
const sched = plan(cli());                                       // agendada: só a fatia
const full = plan(cli('--full'));                                // manual: 100%
const onlyNew = plan(cli('--only-new'));
ok('agendada: re-verifica só uma fatia (12,5%)', sched && sched.verificar > 0 && sched.verificar < 40);
ok('--full: re-verifica os 40 arquivos', full && full.verificar === 40);
ok('--only-new: não re-verifica ninguém', onlyNew && onlyNew.verificar === 0);

// ---- retomar uma verificação completa interrompida ----
const dbmod = require('../src/core/db');
const db = dbmod.open(config.dbPath(config.load()));
db.exec('DELETE FROM runs');
const T0 = Date.now() - 3600e3;
db.prepare("INSERT INTO runs (job_id,job_name,volume,started_at,finished_at,status) VALUES (?,?,?,?,?,'stopped')").run(job.id, job.name + ' (completa)', 'Fotos', T0, T0 + 1000);
db.prepare("UPDATE files SET last_hashed=? WHERE volume='Fotos'").run(T0 - 86400e3);                      // todos verificados antes
const nDone = db.prepare("UPDATE files SET last_hashed=? WHERE volume='Fotos' AND path < 'f2'").run(T0 + 5000).changes; // alguns lidos pela execução interrompida
const rp = dbmod.resumePoint(db, 'Fotos');
ok('detecta verificação completa interrompida', rp && rp.since === T0 && rp.doneFiles === Number(nDone) && rp.todoFiles === 40 - Number(nDone));
const resumed = plan(cli('--full', '--resume'));
ok('--full --resume pula o que já foi lido', resumed && resumed.verificar === 40 - Number(nDone));
const rp2 = dbmod.resumePoint(db, 'Fotos');
ok('depois de terminar, não há mais o que retomar', rp2 === null);
db.exec('DELETE FROM runs');
db.prepare("INSERT INTO runs (job_id,job_name,volume,started_at,finished_at,status) VALUES (?,?,?,?,?,'stopped')").run(job.id, job.name + ' (completa)', 'Fotos', T0, T0 + 1000);
db.prepare("INSERT INTO runs (job_id,job_name,volume,started_at,finished_at,status) VALUES (?,?,?,?,?,'ok')").run(job.id, job.name + ' (completa)', 'Fotos', T0 + 5000, T0 + 6000);
ok('verificação completa concluída depois da interrompida: nada a retomar', dbmod.resumePoint(db, 'Fotos') === null);
db.exec('DELETE FROM runs');
db.prepare("INSERT INTO runs (job_id,job_name,volume,started_at,finished_at,status) VALUES (?,?,?,?,?,'stopped')").run(job.id, job.name, 'Fotos', T0, T0 + 1000);
ok('execução interrompida que NÃO era completa não conta', dbmod.resumePoint(db, 'Fotos') === null);
db.close();
console.log(failed ? '\nFALHAS: ' + failed : '\nfull OK'); process.exit(failed ? 1 : 0);
