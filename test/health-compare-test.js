'use strict';
// Parsers de saúde do disco (com saídas de exemplo do diskutil), estatísticas no banco,
// comparação origem × destino e a verificação rápida "só novidades" (via CLI).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhc-'));
const env = { ...process.env, HD_CHECKER_HOME: path.join(tmp, 'app'), HD_CHECKER_VOLUMES: path.join(tmp, 'vols'), HD_CHECKER_NO_KEYCHAIN: '1' };
Object.assign(process.env, { HD_CHECKER_HOME: env.HD_CHECKER_HOME, HD_CHECKER_VOLUMES: env.HD_CHECKER_VOLUMES, HD_CHECKER_NO_KEYCHAIN: '1' });
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const dc = require('../src/core/diskcheck');
const dbmod = require('../src/core/db');
const config = require('../src/core/config');
const { compareTrees } = require('../src/core/compare');

let ok = 0;
const check = (name, fn) => { try { fn(); console.log('  ✔', name); ok++; } catch (e) { console.error('  ✘', name, '\n    ', e.message); process.exitCode = 1; } };
const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });

(async () => {
  console.log('Sistema de arquivos (classificação da saída do diskutil verifyVolume)');
  const OKOUT = 'Started file system verification on disk4s2 Fotos\nVerifying file system\nPerforming fsck_exfat -n -x /dev/rdisk4s2\nChecking volume.\nThe volume Fotos appears to be OK\nFile system check exit code is 0\nFinished file system verification on disk4s2 Fotos';
  const BADOUT = 'Started file system verification on disk4s2 Fotos\nPerforming fsck_exfat -n -x /dev/rdisk4s2\nCluster chain starting at 1234 is cross-linked\nThe volume Fotos was found corrupt and needs to be repaired\nFile system check exit code is 8\nError: -69845: File system verify or repair failed';
  const BUSY = 'Started file system verification on disk4s2 Fotos\nVolume Fotos on disk4s2 failed to unmount: dissented by PID 512 (/Applications/Backblaze.app)\nError: -69842: Volume could not be unmounted';
  check('saída OK => ok', () => assert.strictEqual(dc.classifyVerify(0, OKOUT).status, 'ok'));
  check('arquivos emendados/corrupção => problems, avisa para não gravar', () => { const r = dc.classifyVerify(1, BADOUT); assert.strictEqual(r.status, 'problems'); assert(/NÃO grave/.test(r.summary)); });
  check('volume em uso => busy (e não problems)', () => assert.strictEqual(dc.classifyVerify(1, BUSY).status, 'busy'));
  check('resumo do diskutil info (exFAT, USB, HDD)', () => {
    const s = dc.summarizeInfo({ FilesystemName: 'ExFAT', DeviceIdentifier: 'disk4s2', ParentWholeDisk: 'disk4', Ejectable: true, WritableVolume: true }, { BusProtocol: 'USB', SolidState: false, MediaName: 'WD My Book', SMARTStatus: 'Not Supported', DeviceIdentifier: 'disk4' });
    assert.deepStrictEqual([s.fsType, s.wholeDisk, s.bus, s.solidState], ['ExFAT', 'disk4', 'USB', false]);
  });

  console.log('Banco: histórico e "arquivos novos desde a última checagem"');
  const cfg = config.load(); const job = { ...config.newJob('Fotos'), id: 'jf', slicePercent: 100, maxMinutes: 0, emailOn: 'never' }; cfg.jobs = [job]; config.save(cfg);
  const vol = path.join(env.HD_CHECKER_VOLUMES, 'Fotos'); fs.mkdirSync(vol, { recursive: true });
  const W = (rel, n, dir = vol) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), crypto.randomBytes(n)); };
  for (let i = 0; i < 5; i++) W(`a${i}.dat`, 3000);
  assert.strictEqual(cli('run', '--job', 'jf', '--json', '--no-email').status, 0);
  const db = dbmod.open(config.dbPath(cfg));
  await new Promise((r) => setTimeout(r, 30));
  dbmod.recordHealth(db, { volume: 'Fotos', kind: 'fs', status: 'ok', summary: 'ok', output: OKOUT });
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 3; i++) W(`novo${i}.dat`, 2000);
  db.close();
  assert.strictEqual(cli('run', '--job', 'jf', '--json', '--no-email').status, 0);
  const db2 = dbmod.open(config.dbPath(cfg));
  const st = dbmod.volumeStats(db2, 'Fotos');
  check('última checagem de FS registrada', () => assert(st.lastFsCheck && st.lastFsCheck.status === 'ok'));
  check('conta os 3 arquivos novos desde a checagem de FS', () => assert.strictEqual(st.newSinceFsCheck, 3));
  check('listHealth devolve o histórico', () => assert.strictEqual(dbmod.listHealth(db2, { volume: 'Fotos' }).length, 1));
  db2.close();

  console.log('Verificação rápida: só novidades');
  W('depois_da_copia.dat', 4000);
  const r1 = cli('run', '--job', 'jf', '--json', '--no-email', '--only-new');
  const done1 = r1.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done');
  check('lê apenas o arquivo novo (não os 8 já catalogados)', () => { assert.strictEqual(r1.status, 0, r1.stderr); assert.strictEqual(done1.stats.hashed, 1); assert.strictEqual(done1.stats.new, 1); });
  const rfull = cli('run', '--job', 'jf', '--json', '--no-email');
  const done2 = rfull.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done');
  check('a execução completa continua lendo tudo (fatia 100%)', () => assert.strictEqual(done2.stats.hashed, 9));

  console.log('Comparação origem × destino');
  const S = path.join(tmp, 'origem'), D = path.join(tmp, 'destino');
  for (let i = 0; i < 6; i++) { const buf = crypto.randomBytes(8000); fs.mkdirSync(path.join(S, 'sub'), { recursive: true }); fs.mkdirSync(path.join(D, 'sub'), { recursive: true }); fs.writeFileSync(path.join(S, 'sub', `f${i}.jpg`), buf); fs.writeFileSync(path.join(D, 'sub', `f${i}.jpg`), buf); }
  fs.writeFileSync(path.join(D, 'sub', 'f1.jpg'), fs.readFileSync(path.join(S, 'sub', 'f1.jpg')).subarray(0, 4000));            // truncado
  const flip = fs.readFileSync(path.join(D, 'sub', 'f2.jpg')); flip[100] ^= 1; fs.writeFileSync(path.join(D, 'sub', 'f2.jpg'), flip);   // 1 bit
  fs.unlinkSync(path.join(D, 'sub', 'f3.jpg'));                                                                                            // faltando
  fs.writeFileSync(path.join(D, 'so_no_destino.txt'), 'x');                                                                              // extra
  fs.writeFileSync(path.join(S, '.DS_Store'), 'lixo');
  const full = await compareTrees({ src: S, dst: D });
  check('acha o arquivo truncado (tamanho)', () => assert(full.different.some((d) => d.path === 'sub/f1.jpg' && d.reason === 'tamanho diferente')));
  check('acha 1 bit invertido (mesmo tamanho, hash diferente)', () => assert(full.different.some((d) => d.path === 'sub/f2.jpg' && d.reason === 'conteúdo diferente')));
  check('acha o arquivo que faltou copiar', () => assert.deepStrictEqual(full.missing.map((m) => m.path), ['sub/f3.jpg']));
  check('lista o que só existe no destino', () => assert.deepStrictEqual(full.extra.map((m) => m.path), ['so_no_destino.txt']));
  check('3 arquivos idênticos; .DS_Store ignorado', () => assert.strictEqual(full.same, 3));
  const quick = await compareTrees({ src: S, dst: D, quick: true });
  check('modo rápido pega tamanho/faltando mas NÃO o bit invertido', () => { assert.strictEqual(quick.different.length, 1); assert.strictEqual(quick.missing.length, 1); assert.strictEqual(quick.same, 4); });
  const c = cli('compare', '--src', S, '--dst', D, '--json');
  const lines = c.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('CLI compare: resultado em JSON e código de saída 3 quando há diferenças', () => { assert.strictEqual(c.status, 3); const r = lines.find((l) => l.type === 'compare-result').result; assert.strictEqual(r.counts.different, 2); });
  fs.writeFileSync(path.join(D, 'sub', 'f1.jpg'), fs.readFileSync(path.join(S, 'sub', 'f1.jpg')));
  fs.writeFileSync(path.join(D, 'sub', 'f2.jpg'), fs.readFileSync(path.join(S, 'sub', 'f2.jpg')));
  fs.writeFileSync(path.join(D, 'sub', 'f3.jpg'), fs.readFileSync(path.join(S, 'sub', 'f3.jpg')));
  check('depois de corrigir a cópia, compare dá código 0', () => assert.strictEqual(cli('compare', '--src', S, '--dst', D, '--json').status, 0));

  console.log(`\n${ok} verificações OK${process.exitCode ? ' — HÁ FALHAS' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
