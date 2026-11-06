'use strict';
// Teste de ponta a ponta do núcleo com um "HD" sintético numa pasta temporária.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdchk-'));
process.env.HD_CHECKER_HOME = path.join(tmp, 'app');
process.env.HD_CHECKER_VOLUMES = path.join(tmp, 'vols');
process.env.HD_CHECKER_NO_KEYCHAIN = '1';
const vol = path.join(process.env.HD_CHECKER_VOLUMES, 'Fotos');
fs.mkdirSync(path.join(vol, '2020/Viagem'), { recursive: true });
fs.mkdirSync(path.join(vol, 'System Volume Information'), { recursive: true });
fs.writeFileSync(path.join(vol, 'System Volume Information/ignorar.dat'), 'x');

const config = require('../src/core/config');
const dbmod = require('../src/core/db');
const { executeJob } = require('../src/core/scanner');
const { buildMessage } = require('../src/core/mailer');
const { buildPlist } = require('../src/core/scheduler');

const rnd = (n) => crypto.randomBytes(n);
const W = (rel, buf) => { const p = path.join(vol, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };

// ---------- geradores de arquivos sintéticos ----------
const jpeg = (n = 200000) => Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
  Buffer.from([0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]),
  Buffer.from(rnd(n).map((b) => (b === 0xFF ? 0xFE : b))), Buffer.from([0xFF, 0xD9])]);
const png = (n = 50000) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), rnd(n),
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])]);
function tiff(dataLen = 300000) {            // TIFF little-endian com 1 strip
  const ifdOff = 8, n = 2, dataOff = ifdOff + 2 + n * 12 + 4;
  const b = Buffer.alloc(dataOff);
  b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(ifdOff, 4); b.writeUInt16LE(n, ifdOff);
  const e = (i, tag, type, cnt, val) => { const o = ifdOff + 2 + i * 12; b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(cnt, o + 4); b.writeUInt32LE(val, o + 8); };
  e(0, 273, 4, 1, dataOff); e(1, 279, 4, 1, dataLen);
  return Buffer.concat([b, Buffer.from(rnd(dataLen).map((x) => x | 1))]);
}
const box = (type, payload) => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4); return Buffer.concat([b, payload]); };
const mp4 = (withMoov = true) => Buffer.concat([box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2')), box('mdat', rnd(400000)), ...(withMoov ? [box('moov', rnd(2000))] : [])]);
const wav = () => { const d = rnd(100000), h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); return Buffer.concat([h, d]); };

const goodJpg = jpeg();
W('2020/Viagem/ok.jpg', goodJpg);
W('2020/Viagem/trunc.jpg', goodJpg.subarray(0, 100000));
W('2020/Viagem/zero.jpg', Buffer.alloc(0));
W('2020/Viagem/nosoi.jpg', rnd(5000));
W('2020/Viagem/ok.png', png());
W('2020/Viagem/trunc.png', png().subarray(0, 30000));
const goodTif = tiff();
W('2020/Viagem/ok.dng', goodTif);
W('2020/Viagem/trunc.dng', goodTif.subarray(0, 150000));
const goodMp4 = mp4();
W('2020/Viagem/ok.mp4', goodMp4);
W('2020/Viagem/trunc.mp4', goodMp4.subarray(0, 200000));
W('2020/Viagem/nomoov.mp4', mp4(false));
const goodWav = wav();
W('2020/Viagem/ok.wav', goodWav);
W('2020/Viagem/trunc.wav', goodWav.subarray(0, 50000));
W('notas.txt', 'olá');
W('._lixo.jpg', rnd(100));

// ---------- helpers de teste ----------
const cfg = config.load();
const job = { ...config.newJob('Fotos'), slicePercent: 100, maxMinutes: 0 };
cfg.jobs = [job]; config.save(cfg);
const run = () => executeJob({ job, cfg, sendEmail: false });
const issueKey = (r) => r.newIssues.map((i) => `${i.kind}:${path.basename(i.path)}`).sort();
let ok = 0;
const check = (name, fn) => { try { fn(); console.log('  ✔', name); ok++; } catch (e) { console.error('  ✘', name, '\n   ', e.message); process.exitCode = 1; } };

(async () => {
  console.log('Execução 1 (inventário inicial)');
  const r1 = await run();
  const k1 = issueKey(r1);
  check('ignora System Volume Information e ._arquivos', () => assert.strictEqual(r1.stats.total, 15 - 1 /* ._lixo */ - 0));
  check('todos os arquivos viram novos', () => assert.strictEqual(r1.stats.new, 14));
  check('detecta arquivo de 0 bytes', () => assert(k1.includes('estrutura:zero.jpg')));
  check('detecta JPEG sem cabeçalho', () => assert(k1.includes('estrutura:nosoi.jpg')));
  check('JPEG sem EOI vira só aviso', () => { const i = r1.newIssues.find((x) => x.path.endsWith('trunc.jpg')); assert(i && i.severity === 'warn'); });
  check('detecta PNG truncado', () => assert(k1.includes('estrutura:trunc.png')));
  check('detecta DNG/TIFF truncado', () => assert(k1.includes('estrutura:trunc.dng')));
  check('detecta MP4 truncado', () => assert(k1.includes('estrutura:trunc.mp4')));
  check('detecta MP4 sem moov', () => assert(k1.includes('estrutura:nomoov.mp4')));
  check('detecta WAV truncado', () => assert(k1.includes('estrutura:trunc.wav')));
  check('NÃO acusa arquivos bons', () => ['ok.jpg', 'ok.png', 'ok.dng', 'ok.mp4', 'ok.wav', 'notas.txt'].forEach((n) => assert(!k1.some((x) => x.endsWith(':' + n)), n)));

  console.log('Execução 2 (nada mudou)');
  const r2 = await run();
  check('sem novos problemas', () => assert.strictEqual(r2.newIssues.length, 0));
  check('re-verificou todos os arquivos (fatia 100%)', () => assert.strictEqual(r2.stats.hashed, 14));

  console.log('Execução 3 (bit rot simulado + edição legítima + apagado + movido)');
  const okPath = path.join(vol, '2020/Viagem/ok.jpg');
  const st = fs.statSync(okPath);
  const corrupt = Buffer.from(goodJpg); corrupt[50000] ^= 0x01;       // 1 bit invertido
  fs.writeFileSync(okPath, corrupt); fs.utimesSync(okPath, st.atime, st.mtime);   // mesma data e tamanho!
  fs.appendFileSync(path.join(vol, 'notas.txt'), ' editado');       // edição legítima (tamanho muda)
  fs.unlinkSync(path.join(vol, '2020/Viagem/ok.wav'));              // apagado
  fs.renameSync(path.join(vol, '2020/Viagem/ok.png'), path.join(vol, '2020/ok_renomeado.png')); // movido
  const r3 = await run();
  const k3 = issueKey(r3);
  check('detecta bit rot (conteúdo mudou, data/tamanho iguais)', () => assert(k3.includes('bitrot:ok.jpg')));
  check('edição legítima não gera alerta', () => assert(!k3.some((x) => x.includes('notas.txt'))));
  check('registra edição como alterado', () => assert.strictEqual(r3.stats.changed, 1));
  check('detecta arquivo sumido', () => assert(k3.includes('missing:ok.wav')));
  check('arquivo renomeado/movido NÃO é "sumido"', () => { assert(!k3.some((x) => x.includes('ok.png'))); assert.strictEqual(r3.stats.moved, 1); });

  console.log('Execução 4 (problema continua aberto, sem duplicar)');
  const r4 = await run();
  check('não repete o alerta de bit rot', () => assert.strictEqual(r4.newIssues.length, 0));
  const db = dbmod.open(config.dbPath(cfg));
  check('bit rot segue aberto no banco', () => assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bitrot' AND resolved=0").get().n, 1));

  console.log('Execução 5 (arquivo restaurado da Backblaze)');
  fs.writeFileSync(okPath, goodJpg); fs.utimesSync(okPath, st.atime, st.mtime);
  const r5 = await run();
  check('alerta resolvido automaticamente', () => assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='bitrot' AND resolved=0").get().n, 0));
  check('sem novos problemas', () => assert.strictEqual(r5.newIssues.length, 0));
  check('estatísticas de cobertura', () => { const s = dbmod.volumeStats(db, 'Fotos'); assert(s.files > 0 && s.never === 0); });
  db.close();

  console.log('Execução 6 (disco desconectado)');
  const job2 = { ...job, volume: 'NaoExiste' };
  const r6 = await executeJob({ job: job2, cfg, sendEmail: false });
  check('pula sem acusar nada', () => { assert.strictEqual(r6.status, 'skipped'); assert.strictEqual(r6.newIssues.length, 0); });

  console.log('E-mail e agendador');
  const msg = buildMessage(r3);
  check('e-mail descreve o problema e o que fazer', () => { assert(/ok\.jpg/.test(msg.text)); assert(/Backblaze/.test(msg.text)); assert(/⚠️/.test(msg.subject)); });
  const plist = buildPlist({ ...job, schedule: { type: 'weekly', weekday: 0, hour: 2, minute: 30 } }, { execPath: '/Applications/Electron', cliPath: '/x/cli.js' });
  fs.writeFileSync(path.join(tmp, 't.plist'), plist);
  check('plist gerado contém horário e comando', () => { assert(/<key>Weekday<\/key><integer>0<\/integer>/.test(plist)); assert(/caffeinate/.test(plist)); assert(/ELECTRON_RUN_AS_NODE/.test(plist)); });

  console.log(`\n${ok} verificações OK${process.exitCode ? ' — HÁ FALHAS' : ''}`);
  console.log('plist de exemplo:', path.join(tmp, 't.plist'));
})().catch((e) => { console.error(e); process.exit(1); });
