const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'ui');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('<script src="app.js"></script>', '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.confirm = () => true;

const now = Date.now();
const calls = [];
const cfg = { jobs: [{ id: 'j1', name: 'Verificação Fotos', volume: 'Fotos', enabled: true, schedule: { type: 'weekly', weekday: 0, hour: 2, minute: 0 }, slicePercent: 12.5, maxMinutes: 480, ignore: ['*.tmp'], validate: true, emailOn: 'issues' }],
  smtp: { host: 'smtp.gmail.com', port: 587, secure: false, user: 'a@b.com', from: '', to: 'a@b.com', passwordSet: true },
  resolvedDbPath: '/Users/x/Library/Application Support/hd_checker/inventory.db', volumesRoot: '/Volumes', scheduled: { j1: true }, platform: 'darwin' };
const ev = [
  { id: 1, volume: 'Fotos', path: '2015/<img src=x onerror=alert(1)>.jpg', kind: 'bitrot', severity: 'error', detail: 'conteúdo mudou', at: now, resolved: 0 },
  { id: 2, volume: 'Fotos', path: '2009/Casamento/C (240).JPG', kind: 'estrutura', severity: 'error', detail: 'zero_bytes: arquivo vazio', at: now, resolved: 0 },
  { id: 3, volume: 'Fotos', path: '2005/x.jpg', kind: 'estrutura', severity: 'warn', detail: 'jpeg_sem_EOI', at: now, resolved: 0 }];
window.api = {
  listVolumes: async () => [
    { name: 'Fotos', total: 8e12, used: 5.1e12, offline: false, jobs: ['j1'], resume: { since: now - 1e7, runs: 2, doneFiles: 74196, doneBytes: 2e11, todoFiles: 20263, todoBytes: 7e11 }, info: { fsType: 'exfat', bus: 'USB', solidState: false }, stats: { files: 300084, bytes: 5e12, never: 12, d30: 40000, d90: 150000, d365: 290000, oldestVerified: now - 9e9, openErrors: 2, openWarnings: 1, lastFsCheck: null, newSinceFsCheck: 0, lastRun: { started_at: now - 1e6, finished_at: now - 5e5, status: 'issues' } } },
    { name: 'Fotos_02', total: 8e12, used: 2e12, offline: false, jobs: [], stats: { files: 0, never: 0, d30: 0, d90: 0, d365: 0, openErrors: 0, openWarnings: 0, lastRun: null } }],
  appVersion: async () => '1.0.0',
  getConfig: async () => JSON.parse(JSON.stringify(cfg)),
  saveSettings: async (s) => { calls.push(['saveSettings', s]); return cfg; },
  createJob: async (v) => { calls.push(['createJob', v]); const job = { ...cfg.jobs[0], id: 'j2', volume: v, name: 'Verificação ' + v, enabled: false }; cfg.jobs.push(job); cfg.scheduled.j2 = false; return { job, config: cfg }; },
  saveJob: async (j) => { calls.push(['saveJob', j]); return { error: null, config: cfg }; },
  deleteJob: async (id) => { calls.push(['deleteJob', id]); return cfg; },
  startScan: async (id, o) => { calls.push(['startScan', id, o]); return { ok: true }; },
  stopScan: async () => true, scanStatus: async () => [], backgroundRuns: async () => window.__bg || [],
  listRuns: async () => [{ id: 7, volume: 'Fotos', started_at: now - 3e6, finished_at: now - 1e6, status: 'issues', note: null, files_hashed: 1000, bytes_read: 5e10, files_new: 3, files_changed: 1, files_missing: 0, issues: 2 }],
  listEvents: async (f) => { calls.push(['listEvents', f]); return ev.filter((e) => !f.severity || (f.severity === 'error' ? e.severity === 'error' : e.severity !== 'error')); },
  countEvents: async (f) => { calls.push(['countEvents', f]); return 12345; },
  resolveBulk: async (x) => { calls.push(['resolveBulk', x]); return { count: 7 }; },
  resolveEvents: async (x) => { calls.push(['resolveEvents', x]); return true; },
  exportCsv: async () => ({ ok: true, count: 3 }), reveal: async () => ({ ok: true }), testEmail: async () => ({ ok: true }),
  revealDb: async () => { calls.push(['revealDb']); return { ok: true }; },
  verifyFs: async (v) => { calls.push(['verifyFs', v]); return { ok: true, status: 'ok', summary: 'O volume parece estar OK.' }; },
  ejectVolume: async (v) => { calls.push(['eject', v]); if (window.__busy && !window.__ejectedAfterKill) return { ok: false, busy: true, error: 'busy', holders: [{ pid: 724, label: 'Pré-visualização (Quick Look)', files: 1, killable: true }, { pid: 77, label: 'Spotlight (indexação)', files: 9, killable: false }] }; return { ok: true }; },
  killHolders: async (v, pids) => { calls.push(['killHolders', v, pids]); window.__ejectedAfterKill = true; return { ok: true, termed: pids, failed: [], remaining: [], skipped: [] }; },
  listHealth: async () => [{ id: 1, volume: 'Fotos', kind: 'fs', at: now, status: 'ok', summary: 'O volume parece estar OK.', output: 'Checking file system\nThe volume appears to be OK' }],
  onHealthEvent: (cb) => { window.__healthCb = cb; },
  onScanEvent: (cb) => { window.__scanCb = cb; }, onScanExit: (cb) => { window.__exitCb = cb; },
};
let failed = 0;
const ok = (n, c) => { console.log(c ? '  ✔' : '  ✘', n); if (!c) failed++; };
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.querySelector('#view').textContent;
const click = (sel, txt) => { const el = [...window.document.querySelectorAll(sel)].find((e) => !txt || e.textContent.includes(txt)); if (!el) throw new Error('não achei ' + sel + ' ' + (txt || '')); el.click(); };

(async () => {
  window.eval(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'));
  await wait(100);
  console.log('Discos');
  ok('mostra os dois discos', text().includes('Fotos') && text().includes('Fotos_02'));
  ok('mostra cobertura e problemas', text().includes('300.084') && text().includes('2 problema'));
  ok('badge mostra o total real, não um teto', window.document.querySelector('#badge').textContent === (12345).toLocaleString('pt-BR'));
  const btnsCount = (t) => [...window.document.querySelectorAll('#view button')].filter((b) => b.textContent === t).length;
  ok('mostra aviso de verificação completa interrompida', text().includes('foi interrompida') && text().includes('74.196') && text().includes('20.263'));
  ok('só o disco com verificação interrompida mostra "Continuar de onde parou"', btnsCount('Continuar de onde parou') === 1);
  const btns = (t) => [...window.document.querySelectorAll('#view button')].filter((b) => b.textContent === t);
  btns('Agendamento')[1].click(); await wait(100);
  ok('criar job abre a aba Agendamentos', calls.some((c) => c[0] === 'createJob' && c[1] === 'Fotos_02') && text().includes('Fotos_02'));
  console.log('Agendamentos');
  click('#view .list button', 'Verificação Fotos'); await wait(80);
  ok('formulário do job renderiza', text().includes('Fatia por execução') && text().includes('Limite de duração'));
  ok('dica de ciclo (12,5% => 8 execuções)', text().includes('8 execuções'));
  const slice = window.document.querySelector('input[type=number]'); slice.value = '25'; slice.dispatchEvent(new window.Event('input'));
  ok('dica atualiza ao mudar a fatia (25% => 4)', text().includes('4 execuções'));
  const sel = () => [...window.document.querySelectorAll('.form select, .form input[type=time]')];
  const schedEls = sel().filter((e) => e.type === 'time' || (e.options && ['Semanal', 'Diária'].includes(e.options[0].textContent)) || (e.options && e.options[0].textContent === 'Domingo'));
  ok('com "Executar automaticamente" marcado, a agenda fica habilitada', schedEls.length >= 2 && schedEls.every((e) => !e.disabled));
  const en = window.document.querySelector('.form input[type=checkbox]'); en.checked = false; en.dispatchEvent(new window.Event('change'));
  ok('desmarcado: frequência, dia e horário ficam desabilitados', schedEls.every((e) => e.disabled) && window.document.querySelectorAll('.form .disabled-field').length >= 2);
  ok('desmarcado: fatia e limite (só do agendado) também ficam desabilitados', [...window.document.querySelectorAll('.form input[type=number]')].every((e) => e.disabled));
  en.checked = true; en.dispatchEvent(new window.Event('change'));
  ok('marcar de novo reabilita a agenda, a fatia e o limite', schedEls.every((e) => !e.disabled) && [...window.document.querySelectorAll('.form input[type=number]')].every((e) => !e.disabled));
  click('button', 'Salvar'); await wait(80);
  const saved = calls.filter((c) => c[0] === 'saveJob').pop();
  ok('salva o job com os valores do formulário', saved && saved[1].slicePercent === 25 && saved[1].maxMinutes === 480 && saved[1].ignore[0] === '*.tmp' && saved[1].schedule.hour === 2);
  console.log('Relatórios');
  window.document.querySelector('[data-tab=relatorios]').click(); await wait(100);
  ok('avisa que a lista está cortada (3 de 12.345)', text().includes('Mostrando 2 de 12.345') || text().includes('Mostrando 3 de 12.345'));
  ok('lista os problemas abertos', text().includes('C (240).JPG') && text().includes('zero_bytes'));
  ok('avisos não aparecem no filtro "só erros"', !text().includes('jpeg_sem_EOI'));
  ok('nome de arquivo malicioso NÃO vira HTML (XSS)', !window.document.querySelector('#view img') && text().includes('<img src=x'));
  ok('mostra histórico de execuções', text().includes('Histórico de execuções') && text().includes('1.000 arq'));
  ok('recomenda restaurar a partir do backup', text().includes('a partir do seu backup'));
  click('button', 'Aceitar versão atual'); await wait(80);
  ok('aceitar versão chama a API com ação correta', calls.some((c) => c[0] === 'resolveEvents' && c[1].action === 'accept' && c[1].ids[0] === 1));
  click('button', 'Ignorar'); await wait(80);
  ok('ignorar chama a API', calls.some((c) => c[0] === 'resolveEvents' && c[1].action === 'dismiss'));
  ok('histórico de saúde aparece em Relatórios', text().includes('Saúde dos discos') && text().includes('Sistema de arquivos'));
  ok('rodapé da barra lateral mostra a versão e não o texto antigo', window.document.querySelector('.side-foot').textContent.trim() === 'Versão 1.0.0' && !text().includes('Nunca altera'));
  console.log('Relatórios: lote por pasta');
  const selKind = [...window.document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === 'missing'));
  selKind.value = 'missing'; selKind.dispatchEvent(new window.Event('change')); await wait(80);
  const pf = window.document.querySelector('#prefixFilter'); pf.value = '2014, 2015'; pf.dispatchEvent(new window.Event('change')); await wait(80);
  ok('filtro de pasta e tipo chegam à API', calls.some((c) => c[0] === 'listEvents' && c[1].kind === 'missing' && c[1].prefix === '2014, 2015'));
  ok('mostra o botão de lote com a contagem', !!window.document.querySelector('#bulkResolve') && text().includes('12.345'));
  window.confirm = () => true; window.document.querySelector('#bulkResolve').click(); await wait(100);
  ok('lote chama resolveBulk com a pasta', calls.filter((c) => c[0] === 'resolveBulk').length === 2 && calls.some((c) => c[0] === 'resolveBulk' && c[1].prefix === '2014, 2015' && !c[1].dryRun));
  console.log('Discos: saúde');
  window.document.querySelector('[data-tab=discos]').click(); await wait(100);
  ok('mostra o formato exFAT e não repete o aviso sobre journal', text().includes('exfat') && !text().includes('Sem journal'));
  ok('mostra "nunca checado"', text().includes('nunca checado'));
  click('button', 'Checar sistema de arquivos'); await wait(80);
  ok('checar FS chama a API com o disco certo', calls.some((c) => c[0] === 'verifyFs' && c[1] === 'Fotos'));
  click('button', 'Ejetar'); await wait(80);
  ok('ejetar chama a API', calls.some((c) => c[0] === 'eject' && c[1] === 'Fotos'));
  window.__busy = true; calls.length = 0; let asked = '';
  window.confirm = (m) => { asked = m; return true; };
  click('button', 'Ejetar'); await wait(120);
  ok('ejeção bloqueada mostra quem está usando o disco', asked.includes('Quick Look') && asked.includes('Spotlight') && asked.includes('não pode encerrar'));
  ok('só pede para encerrar quem pode (QuickLook, não o Spotlight)', calls.some((c) => c[0] === 'killHolders' && c[2].length === 1 && c[2][0] === 724));
  ok('tenta ejetar de novo depois de encerrar', calls.filter((c) => c[0] === 'eject').length === 2);
  window.__busy = false; window.confirm = () => true;
  click('button', 'Continuar de onde parou'); await wait(80);
  ok('"Continuar de onde parou" roda a verificação completa em modo resume', calls.some((c) => c[0] === 'startScan' && c[1] === 'j1' && c[2] && c[2].full === true && c[2].resume === true));
  window.__exitCb({ jobId: 'j1', code: 0 }); await wait(60);
  click('button', 'Verificação completa'); await wait(80);
  ok('"Verificação completa" lê 100% (full), sem depender do job', calls.some((c) => c[0] === 'startScan' && c[1] === 'j1' && c[2] && c[2].full === true));
  const nCreate = calls.filter((c) => c[0] === 'createJob').length;
  btns('Verificação completa')[1].click(); await wait(100);
  ok('disco sem job: verificação completa cria um job e roda sem configurar nada', calls.filter((c) => c[0] === 'createJob').length === nCreate + 1 && calls.some((c) => c[0] === 'startScan' && c[1] === 'j2' && c[2] && c[2].full === true));
  window.__exitCb({ jobId: 'j2', code: 0 }); window.__exitCb({ jobId: 'j1', code: 0 }); await wait(60);
  click('button', 'Verificação das mudanças'); await wait(80);
  ok('"Verificação das mudanças" inicia com onlyNew', calls.some((c) => c[0] === 'startScan' && c[1] === 'j1' && c[2] && c[2].onlyNew === true));
  window.__exitCb({ jobId: 'j1', code: 0 }); await wait(50);
  console.log('Configurações');
  window.document.querySelector('[data-tab=config]').click(); await wait(80);
  ok('mostra SMTP e caminho do banco', window.document.querySelector('input[type=text]').value === 'smtp.gmail.com' && text().includes('inventory.db'));
  ok('sem opção de backup na tela', !text().includes('Copiar agora') && !text().includes('Pasta de backup'));
  click('button', 'Mostrar no Finder'); await wait(50);
  ok('mostrar banco no Finder chama a API', calls.some((c) => c[0] === 'revealDb'));
  click('button', 'Salvar e enviar teste'); await wait(80);
  ok('salva configurações antes de testar e-mail', calls.some((c) => c[0] === 'saveSettings' && c[1].smtp.host === 'smtp.gmail.com'));
  console.log('Progresso da varredura');
  window.__scanCb({ jobId: 'j1', type: 'progress', filesDone: 500, filesTotal: 2000, bytesDone: 2e9, bytesTotal: 8e9, current: '2015/IMG_0001.jpg', rate: 1.2e8, etaSec: 3000, issues: 1 });
  const banner = window.document.querySelector('#banner');
  ok('banner mostra % e velocidade', !banner.classList.contains('hidden') && banner.textContent.includes('25%') && banner.textContent.includes('120 MB/s'));
  window.__scanCb({ jobId: 'j2', type: 'progress', filesDone: 10, filesTotal: 100, bytesDone: 1e9, bytesTotal: 4e9, current: 'x.jpg', rate: 5e7, etaSec: 60, issues: 0 });
  ok('dois discos ao mesmo tempo no banner', banner.textContent.includes('Fotos_02') && banner.textContent.includes('25%') && banner.querySelectorAll('.bar').length === 2);
  ok('título da janela mostra o andamento', window.document.title.includes('Fotos') && window.document.title.includes('25%'));
  window.__exitCb({ jobId: 'j2', code: 0 }); await wait(30);
  window.__exitCb({ jobId: 'j1', code: 0 }); await wait(80);
  ok('banner some ao terminar', window.document.querySelector('#banner').classList.contains('hidden'));
  console.log('Execução agendada em segundo plano');
  window.__bg = [{ id: 99, jobId: 'j1', name: 'Verificação Fotos', volume: 'Fotos_00', startedAt: now, heartbeat: now, filesDone: 1234, filesTotal: 9000, bytesRead: 5e9, issues: 2 }];
  await window.pollBackground(); await wait(30);
  const b2 = window.document.querySelector('#banner');
  ok('execução agendada aparece no topo', !b2.classList.contains('hidden') && b2.textContent.includes('Fotos_00') && b2.textContent.includes('segundo plano') && b2.textContent.includes('1.234'));
  ok('título da janela cita o disco', window.document.title.includes('Fotos_00'));
  window.__bg = []; await window.pollBackground(); await wait(60);
  ok('some quando a execução termina', window.document.querySelector('#banner').classList.contains('hidden') && window.document.title === 'HD Checker');
  console.log(failed ? '\nFALHAS: ' + failed : '\nUI OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
