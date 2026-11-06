const Module = require('module'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdmain-'));
process.env.HD_CHECKER_HOME = path.join(tmp, 'app'); process.env.HD_CHECKER_VOLUMES = path.join(tmp, 'vols'); process.env.HD_CHECKER_NO_KEYCHAIN = '1';
const vol = path.join(process.env.HD_CHECKER_VOLUMES, 'Fotos'); fs.mkdirSync(vol, { recursive: true });

const handlers = {}; const shown = [];
const electronMock = {
  app: { whenReady: () => new Promise(() => {}), on() {}, quit() {}, setName() {}, dock: { setIcon() {} } },
  BrowserWindow: class { static getAllWindows() { return []; } },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(tmp, 'out.csv') }), showOpenDialog: async () => ({ canceled: true }) },
  shell: { showItemInFolder: (p) => shown.push(p), openPath: (p) => shown.push(p) },
};
const orig = Module._load;
Module._load = function (req, ...a) { return req === 'electron' ? electronMock : orig.call(this, req, ...a); };

const jpeg = (seed) => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), Buffer.from([0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0]), Buffer.alloc(5000, seed), Buffer.from([0xFF, 0xD9])]);
fs.writeFileSync(path.join(vol, 'a.jpg'), jpeg(1)); fs.writeFileSync(path.join(vol, 'b.jpg'), jpeg(2)); fs.writeFileSync(path.join(vol, 'c.jpg'), jpeg(3));

const config = require('../src/core/config');
const { executeJob } = require('../src/core/scanner');
let failed = 0; const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };

(async () => {
  const cfg = config.load(); const job = { ...config.newJob('Fotos'), slicePercent: 100, maxMinutes: 0 }; cfg.jobs = [job]; config.save(cfg);
  await executeJob({ job, cfg, sendEmail: false });
  const pa = path.join(vol, 'a.jpg'), st = fs.statSync(pa);
  const bad = fs.readFileSync(pa); bad[100] ^= 1; fs.writeFileSync(pa, bad); fs.utimesSync(pa, st.atime, st.mtime);   // bit rot em a.jpg
  fs.unlinkSync(path.join(vol, 'b.jpg'));                                                                          // b.jpg apagado
  await executeJob({ job, cfg: config.load(), sendEmail: false });

  require('../electron/main.js');
  const vols = await handlers['volumes:list']();
  ok('volumes:list inclui Fotos com estatísticas', vols.length === 1 && vols[0].name === 'Fotos' && vols[0].stats.openErrors === 1 && vols[0].jobs[0] === job.id);
  { const dx = require('../src/core/db').open(config.dbPath(config.load()));
    dx.prepare("INSERT INTO files (volume,path,size,mtime_ms,hash,first_seen,last_hashed,status) VALUES ('Antigo','x.jpg',1,1,'h',1,1,'ok')").run(); dx.close();
    const v2 = await handlers['volumes:list']();
    ok('disco desconectado com inventário e sem job continua na lista', v2.some((v) => v.name === 'Antigo' && v.offline && v.jobs.length === 0));
    const dy = require('../src/core/db').open(config.dbPath(config.load())); dy.prepare("DELETE FROM files WHERE volume='Antigo'").run(); dy.close(); }
  const open = await handlers['events:list']({}, { state: 'open' });
  const rot = open.find((e) => e.kind === 'bitrot'), miss = open.find((e) => e.kind === 'missing');
  ok('events:list traz bit rot e arquivo sumido', rot && miss && rot.path === 'a.jpg' && miss.path === 'b.jpg');
  ok('ordena erros antes de avisos', open[0].severity === 'error');
  ok('filtro só erros', (await handlers['events:list']({}, { state: 'open', severity: 'error' })).every((e) => e.severity === 'error'));
  const r = await handlers['shell:reveal']({}, { volume: 'Fotos', rel: 'a.jpg' });
  ok('shell:reveal abre o arquivo no Finder', r.ok && shown[0] === pa);
  const r2 = await handlers['shell:reveal']({}, { volume: 'Fotos', rel: 'b.jpg' });
  ok('reveal de arquivo sumido abre a pasta', r2.ok && r2.note);
  await handlers['events:resolve']({}, { ids: [miss.id], action: 'dismiss' });
  await handlers['events:resolve']({}, { ids: [rot.id], action: 'accept' });
  ok('após resolver, não há mais eventos abertos', (await handlers['events:list']({}, { state: 'open' })).length === 0);
  const res = await executeJob({ job, cfg: config.load(), sendEmail: false });
  ok('após "aceitar", nova execução não acusa o a.jpg de novo', res.newIssues.length === 0);
  ok('após "foi apagado de propósito", b.jpg não volta como sumido', !res.newIssues.some((i) => i.path === 'b.jpg'));
  const csv = await handlers['events:exportCsv']({}, { state: 'all' }); ok('exporta CSV', csv.ok && fs.readFileSync(path.join(tmp, 'out.csv'), 'utf8').includes('bitrot'));
  const s = await handlers['settings:save']({}, { smtp: { host: 'smtp.x.com', user: 'u@x.com', to: 'u@x.com' }, smtpPassword: 'segredo' });
  ok('settings:save guarda SMTP sem expor a senha no config.json', s.smtp.host === 'smtp.x.com' && s.smtp.passwordSet && !fs.readFileSync(path.join(tmp, 'app/config.json'), 'utf8').includes('segredo'));
  const rv = await handlers['db:reveal'](); ok('db:reveal abre o banco no Finder', rv.ok && shown.pop() === config.dbPath(config.load()));
  const j = await handlers['job:save']({}, { ...job, enabled: true });
  ok('job:save agenda (no Linux avisa que launchd é só macOS)', j.error && /macOS/.test(j.error));
  ok('events:count devolve o total sem limite', (await handlers['events:count']({}, { state: 'all' })) >= 2);
  const stt = await handlers['scan:status'](); ok('scan:status devolve lista vazia sem varreduras', Array.isArray(stt) && stt.length === 0);
  const hl = await handlers['health:list']({}, { limit: 5 }); ok('health:list responde lista', Array.isArray(hl));
  const dbm = require('../src/core/db'), dbx = dbm.open(config.dbPath(config.load()));
  dbx.prepare("INSERT INTO runs (job_id,job_name,volume,started_at,heartbeat,pid,status,files_hashed,bytes_read) VALUES ('jx','Agendada','Fotos_00',?,?,?,'running',42,1000)").run(Date.now(), Date.now(), process.pid);
  const bg = await handlers['scan:background'](); dbx.prepare("DELETE FROM runs WHERE job_id='jx'").run(); dbx.close();
  ok('scan:background lista execuções de outro processo', bg.length === 1 && bg[0].volume === 'Fotos_00' && bg[0].filesDone === 42);
  const dbb = dbm.open(config.dbPath(config.load()));
  const ins = dbb.prepare("INSERT INTO events (run_id,volume,path,kind,severity,detail,at,resolved) VALUES (1,?,?,'missing','warn','sumiu',?,0)");
  for (const [v, pth] of [['Fotos', '2014/a/x.jpg'], ['Fotos', '2014/b.jpg'], ['Fotos', '2015/c.jpg'], ['Fotos', '2014_extra/d.jpg'], ['Fotos', '2016/e_f.jpg'], ['Fotos_02', '2014/z.jpg']]) ins.run(v, pth, Date.now());
  dbb.prepare("INSERT INTO files (volume,path,size,mtime_ms,hash,first_seen,last_hashed,status) VALUES ('Fotos','2014/b.jpg',1,1,'h',1,1,'ok')").run();
  const cnt = (f) => handlers['events:count']({}, { state: 'open', kind: 'missing', ...f });
  ok('filtro por pasta casa só dentro da pasta (2014 não pega 2014_extra)', (await cnt({ volume: 'Fotos', prefix: '2014' })) === 2);
  ok('filtro com várias pastas e barra final', (await cnt({ volume: 'Fotos', prefix: '/2014/, 2015/' })) === 3);
  ok('curinga _ do LIKE não vaza', (await cnt({ volume: 'Fotos', prefix: '2016/e' })) === 0);
  ok('dryRun só conta', (await handlers['events:resolveBulk']({}, { volume: 'Fotos', prefix: '2014', dryRun: true })).count === 2 && (await cnt({ volume: 'Fotos', prefix: '2014' })) === 2);
  const bulk = await handlers['events:resolveBulk']({}, { volume: 'Fotos', prefix: '2014, 2015' });
  ok('resolveBulk resolve só o disco e as pastas pedidas', bulk.count === 3 && (await cnt({})) === 3 && (await cnt({ volume: 'Fotos_02' })) === 1);
  ok('resolveBulk remove o arquivo do inventário', !dbb.prepare("SELECT 1 FROM files WHERE volume='Fotos' AND path='2014/b.jpg'").get());
  const rs = await handlers['events:list']({}, { state: 'resolved', prefix: '2015' }); ok('resolvido registra o motivo', rs.length === 1 && /em lote/.test(rs[0].resolution));
  dbb.prepare("DELETE FROM events WHERE path LIKE '%/%' AND detail='sumiu'").run(); dbb.close();
  ok('app:version devolve a versão do package.json', (await handlers['app:version']()) === require('../package.json').version);
  const rr = await handlers['runs:list']({}, 10); ok('runs:list', rr.length === 3);
  console.log(failed ? 'FALHAS: ' + failed : '\nmain.js OK'); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
