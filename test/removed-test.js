'use strict';
// Arquivo com erro que o usuário apagou/trocou: o alerta some sozinho (e não vira "arquivo sumiu").
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
process.env.HD_CHECKER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrem-'));
process.env.HD_CHECKER_VOLUMES = path.join(process.env.HD_CHECKER_HOME, 'vols');
process.env.HD_CHECKER_NO_KEYCHAIN = '1';
const vol = path.join(process.env.HD_CHECKER_VOLUMES, 'Fotos'); fs.mkdirSync(vol, { recursive: true });
const config = require('../src/core/config'), dbmod = require('../src/core/db');
const { executeJob } = require('../src/core/scanner');
let failed = 0; const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };
const jpg = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from([0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0]), Buffer.from(crypto.randomBytes(3000).map((b) => (b === 0xFF ? 0xFE : b | 1))), Buffer.from([0xFF, 0xD9])]);
const P = (n) => path.join(vol, n);
for (const n of ['ok1.jpg', 'ok2.jpg', 'good_deleted.jpg']) fs.writeFileSync(P(n), jpg());
for (const n of ['bad1.jpg', 'bad2.jpg', 'bad3.jpg']) fs.writeFileSync(P(n), Buffer.alloc(0));   // zero_bytes
const cfg = config.load(); const job = { ...config.newJob('Fotos'), slicePercent: 100, maxMinutes: 0 }; cfg.jobs = [job]; config.save(cfg);
const q = (sql, ...a) => { const db = dbmod.open(config.dbPath(config.load())); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
const run = (fn) => { const db = dbmod.open(config.dbPath(config.load())); try { return fn(db); } finally { db.close(); } };

(async () => {
  console.log('1ª execução: 3 arquivos vazios geram erro');
  await executeJob({ job, cfg: config.load(), sendEmail: false });
  ok('3 erros abertos', q("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0").n === 3);

  console.log('Usuário apaga 2 arquivos com erro e 1 arquivo bom');
  fs.unlinkSync(P('bad1.jpg')); fs.unlinkSync(P('bad2.jpg')); fs.unlinkSync(P('good_deleted.jpg'));
  await executeJob({ job, cfg: config.load(), sendEmail: false });
  ok('erros dos apagados foram fechados', q("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0").n === 1);
  ok('o que continua no disco segue em erro', q("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0 AND path='bad3.jpg'").n === 1);
  ok('resolução explica o motivo', /removido do disco/.test(q("SELECT resolution r FROM events WHERE path='bad1.jpg'").r || ''));
  ok('arquivo com erro apagado NÃO gera aviso de "sumiu"', q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND path IN ('bad1.jpg','bad2.jpg')").n === 0);
  ok('arquivo bom apagado continua gerando aviso', q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND resolved=0 AND path='good_deleted.jpg'").n === 1);

  console.log('Estado antigo: erro aberto + aviso "sumiu" de um arquivo já marcado como missing');
  fs.unlinkSync(P('bad3.jpg'));
  run((db) => {
    db.prepare("UPDATE files SET status='missing' WHERE path='bad3.jpg'").run();
    db.prepare("INSERT INTO events (run_id,volume,path,kind,severity,detail,at) VALUES (1,'Fotos','bad3.jpg','missing','warn','arquivo não está mais no disco',?)").run(Date.now());
  });
  const r = await executeJob({ job, cfg: config.load(), sendEmail: false });
  ok('limpa o erro antigo', q("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0").n === 0);
  ok('limpa também o aviso "sumiu" desse arquivo', q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND resolved=0 AND path='bad3.jpg'").n === 0);
  ok('o aviso do arquivo bom permanece', q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND resolved=0 AND path='good_deleted.jpg'").n === 1);
  ok('execução informa a limpeza', /removido/.test(r.note || ''));

  console.log('Arquivos temporários do Backblaze (.bzvol) já inventariados em versões antigas');
  fs.mkdirSync(P('.bzvol'), { recursive: true }); fs.writeFileSync(P('.bzvol/ping_1.log'), 'x');
  run((db) => {
    const t = Date.now();
    db.prepare("INSERT INTO files (volume,path,size,mtime_ms,hash,first_seen,last_hashed,status) VALUES ('Fotos','.bzvol/ping_0.log',1,1,'abc',?,?,'missing')").run(t, t);
    db.prepare("INSERT INTO files (volume,path,size,mtime_ms,hash,first_seen,last_hashed,status) VALUES ('Fotos','.bzvol/ping_1.log',1,1,'def',?,?,'ok')").run(t, t);
    db.prepare("INSERT INTO events (run_id,volume,path,kind,severity,detail,at) VALUES (1,'Fotos','.bzvol/ping_0.log','missing','warn','arquivo não está mais no disco',?)").run(t);
  });
  const r2 = await executeJob({ job, cfg: config.load(), sendEmail: false });
  ok('alerta "sumiu" de .bzvol é fechado', q("SELECT COUNT(*) n FROM events WHERE path LIKE '.bzvol/%' AND resolved=0").n === 0);
  ok('arquivos de .bzvol saem do inventário', q("SELECT COUNT(*) n FROM files WHERE path LIKE '.bzvol/%'").n === 0);
  ok('.bzvol não é mais listado nem vira "sumiu" depois', q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND path LIKE '.bzvol/%'").n === 1 && q("SELECT COUNT(*) n FROM events WHERE kind='missing' AND resolved=0 AND path LIKE '.bzvol/%'").n === 0);
  ok('a execução informa a limpeza', /ignoradas/.test(r2.note || ''));
  console.log(failed ? '\nFALHAS: ' + failed : '\nremoved OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
