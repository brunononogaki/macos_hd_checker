'use strict';
// JPEG com preenchimento de zeros depois do FFD9 (comum em celulares) NÃO é corrupção; corte no meio + zeros É.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
process.env.HD_CHECKER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hdpad-'));
process.env.HD_CHECKER_VOLUMES = path.join(process.env.HD_CHECKER_HOME, 'vols');
process.env.HD_CHECKER_NO_KEYCHAIN = '1';
const vol = path.join(process.env.HD_CHECKER_VOLUMES, 'Fotos'); fs.mkdirSync(vol, { recursive: true });
const checks = require('../src/core/checks'), config = require('../src/core/config'), dbmod = require('../src/core/db');
const { executeJob } = require('../src/core/scanner');
const validate = checks.validate || checks.validateFile;
let failed = 0; const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };
const body = (n) => Buffer.from(crypto.randomBytes(n).map((b) => ((b | 1) === 0xFF ? 0x7F : b | 1)));   // sem zeros nem FF
const head = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from([0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0])]);
const padded = Buffer.concat([head, body(200000), Buffer.from([0xFF, 0xD9]), Buffer.alloc(170000)]);
const cut = Buffer.concat([head, body(200000), Buffer.alloc(170000)]);
const trailer = Buffer.concat([head, body(200000), Buffer.from([0xFF, 0xD9]), body(300000), Buffer.alloc(170000)]);   // foto + mapa de profundidade + zeros
const trailerNoZeros = Buffer.concat([head, body(200000), Buffer.from([0xFF, 0xD9]), body(300000)]);
fs.writeFileSync(path.join(vol, 'trailer.jpg'), trailer); fs.writeFileSync(path.join(vol, 'trailer2.jpg'), trailerNoZeros);
fs.writeFileSync(path.join(vol, 'padded.jpg'), padded); fs.writeFileSync(path.join(vol, 'cut.jpg'), cut);
(async () => {
  ok('JPEG completo + zeros de preenchimento: sem erro', (await validate(path.join(vol, 'padded.jpg'), padded.length, 'jpg')) === null);
  ok('foto + dados extras do celular + zeros: sem erro', (await validate(path.join(vol, 'trailer.jpg'), trailer.length, 'jpg')) === null);
  ok('foto + dados extras sem zeros: sem aviso', (await validate(path.join(vol, 'trailer2.jpg'), trailerNoZeros.length, 'jpg')) === null);
  const r = await validate(path.join(vol, 'cut.jpg'), cut.length, 'jpg');
  ok('JPEG cortado + zeros: continua sendo erro', r && r.level === 'error' && r.code === 'final_todo_zeros');
  // falso positivo já gravado no banco é revalidado e resolvido sozinho
  const cfg = config.load(); const job = { ...config.newJob('Fotos'), slicePercent: 100, maxMinutes: 0 }; cfg.jobs = [job]; config.save(cfg);
  await executeJob({ job, cfg, sendEmail: false });
  const db = dbmod.open(config.dbPath(cfg));
  // simula o estado deixado pela versão antiga: arquivo "suspect" com evento de estrutura (falso positivo) aberto
  db.prepare("UPDATE files SET status='suspect' WHERE path='padded.jpg'").run();
  db.prepare("INSERT INTO events (run_id,volume,path,kind,severity,detail,at) VALUES (1,'Fotos','padded.jpg','estrutura','error','final_todo_zeros: antigo',?)").run(Date.now());
  const open0 = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0 AND path='padded.jpg'").get().n;
  const cutOpen = db.prepare("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0 AND path='cut.jpg'").get().n;
  ok('o arquivo cortado foi acusado na 1ª execução', cutOpen === 1);
  const cfg2 = config.load();
  await executeJob({ job, cfg: cfg2, sendEmail: false });   // 100%: revalida tudo
  ok('falso positivo antigo foi resolvido sozinho', open0 === 1 && db.prepare("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0 AND path='padded.jpg'").get().n === 0);
  ok('status do arquivo voltou a ok', db.prepare("SELECT status FROM files WHERE path='padded.jpg'").get().status === 'ok');
  ok('o arquivo cortado continua acusado', db.prepare("SELECT COUNT(*) n FROM events WHERE kind='estrutura' AND resolved=0 AND path='cut.jpg'").get().n === 1);
  db.close();
  console.log(failed ? 'FALHAS: ' + failed : '\njpeg-padding OK'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
