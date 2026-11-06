'use strict';
/* global api */

// ---------- utilidades ----------
const $ = (s, r = document) => r.querySelector(s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2).replace('.', ',') + ' TB';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return Math.round(n / 1e3) + ' KB';
};
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));
const fmtDate = (t) => (t ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDur = (ms) => {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
};
const fmtEta = (s) => (s == null ? '' : 'falta ~' + fmtDur(s * 1000));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const STATUS = {
  running: ['Em andamento', 'gray'], ok: ['Sem problemas', 'ok'], issues: ['Com problemas', 'err'],
  partial: ['Parcial', 'warn'], stopped: ['Interrompida', 'warn'], skipped: ['Pulada', 'gray'], error: ['Erro', 'err'],
};
const KIND = {
  bitrot: 'Corrupção silenciosa', estrutura: 'Estrutura inválida', ilegivel: 'Erro de leitura', missing: 'Arquivo sumiu',
};
const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const chip = (text, cls) => h('span', { class: 'chip ' + cls }, text);
const bar = (p, cls = '') => { const f = h('div', { class: 'fill ' + cls }); f.style.width = Math.max(0, Math.min(100, p)) + '%'; return h('div', { class: 'bar' }, f); };

let toastTimer = null;
function toast(msg, ms = 4500) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- estado ----------
const state = {
  tab: 'discos', cfg: null, selectedJob: null,
  bg: [],           // execuções em segundo plano (agendadas/CLI), lidas do banco
  scans: {},        // jobId -> { phase, plan, progress }   (vários discos podem rodar ao mesmo tempo)
  health: {},       // volume -> { fs: 'running'|null, lastLine }
  report: { severity: 'error', volume: '', runId: null, state: 'open', kind: '', prefix: '' },
};

const jobVolume = (id) => { const j = state.cfg && state.cfg.jobs.find((x) => x.id === id); return j ? j.volume : ''; };
const isScanning = (volume) => Object.keys(state.scans).some((id) => jobVolume(id) === volume);
const anyScan = () => Object.keys(state.scans).length > 0;
const isFsChecking = (volume) => !!(state.health[volume] && state.health[volume].fs === 'running');

// ---------- banner de progresso ----------
function scanBlock(jobId, s) {
  const p = s.progress;
  const percent = p && p.bytesTotal ? pct(p.bytesDone, p.bytesTotal) : 0;
  return h('div', {},
    h('div', { class: 'row between' },
      h('div', {}, h('b', {}, 'Verificando "' + jobVolume(jobId) + '"'), ' ',
        h('span', { class: 'muted' }, p ? `${percent}% · ${fmtNum(p.filesDone)}/${fmtNum(p.filesTotal)} arquivos · ${fmtBytes(p.rate)}/s · ${fmtEta(p.etaSec)} · problemas: ${p.issues}` : s.phase)),
      h('button', { class: 'btn sm danger', onclick: () => api.stopScan(jobId) }, 'Parar')),
    h('div', { style: 'height:6px' }),
    bar(percent),
    p ? h('div', { class: 'path' }, p.current) : null);
}

// O título da janela também mostra o andamento (aparece no Mission Control e na lista de janelas).
function setWindowTitle() {
  const parts = [];
  for (const [jobId, s] of Object.entries(state.scans)) {
    const p = s.progress;
    parts.push(jobVolume(jobId) + (p && p.bytesTotal ? ' ' + pct(p.bytesDone, p.bytesTotal) + '%' : ''));
  }
  for (const r of state.bg) parts.push(r.volume);
  document.title = parts.length ? 'HD Checker — verificando ' + parts.join(', ') : 'HD Checker';
}

function renderBanner() {
  const b = $('#banner');
  const blocks = [];
  for (const [jobId, s] of Object.entries(state.scans)) blocks.push(scanBlock(jobId, s));
  for (const [vol, hs] of Object.entries(state.health)) {
    if (hs.fs === 'running') blocks.push(h('div', {}, h('b', {}, `Checando o sistema de arquivos de "${vol}"…`), ' ',
      h('span', { class: 'muted' }, hs.lastLine || 'o disco fica desmontado por alguns minutos; não o desconecte')));
  }
  for (const r of state.bg) {
    blocks.push(h('div', {},
      h('div', {}, h('b', {}, 'Verificando "' + r.volume + '"'), ' ',
        h('span', { class: 'muted' }, `em segundo plano (agendada) · ${fmtNum(r.filesDone)} arquivos lidos · ${fmtBytes(r.bytesRead)} · problemas: ${r.issues}`)),
      h('div', { style: 'height:6px' }),
      h('div', { class: 'bar indet' }, h('div', { class: 'fill' }))));
  }
  setWindowTitle();
  if (!blocks.length) { b.classList.add('hidden'); b.replaceChildren(); return; }
  b.classList.remove('hidden');
  b.replaceChildren(...blocks.flatMap((x, i) => (i ? [h('hr', { class: 'sep' }), x] : [x])));
}

async function startScan(jobId, opts = {}) {
  const r = await api.startScan(jobId, opts);
  if (!r.ok) { toast(r.error, 7000); return; }
  state.scans[jobId] = { phase: 'Iniciando…', plan: null, progress: null };
  renderBanner();
  if (state.tab === 'discos') show('discos');
}

// Verificações manuais não dependem de um job configurado: se o disco ainda não tem job, cria um (desativado, sem agendamento).
async function jobFor(v) {
  if (v.jobs[0]) return v.jobs[0];
  const r = await api.createJob(v.name);
  state.cfg = r.config;
  return r.job.id;
}
async function startScanFor(v, opts) { startScan(await jobFor(v), opts); }
async function openSchedule(v) { state.selectedJob = await jobFor(v); show('jobs'); }

function handleScanEvent(ev) {
  const s = state.scans[ev.jobId] || (state.scans[ev.jobId] = { phase: '', plan: null, progress: null });
  if (ev.type === 'phase') s.phase = ev.message;
  else if (ev.type === 'plan') { s.plan = ev; s.phase = `${fmtNum(ev.total)} arquivos: ${fmtNum(ev.novos)} novos, ${fmtNum(ev.alterados)} alterados, ${fmtNum(ev.verificar)} a re-verificar`; }
  else if (ev.type === 'progress') s.progress = ev;
  else if (ev.type === 'done') {
    const [label] = STATUS[ev.status] || [ev.status];
    toast(`${jobVolume(ev.jobId)}: ${label}${ev.note ? ' — ' + ev.note : ''}`, 9000);
  } else if (ev.type === 'result') {
    if (ev.emailError) toast('Verificação feita, mas o e-mail falhou: ' + ev.emailError, 9000);
    else if (ev.emailSent) toast('E-mail de alerta enviado.');
  }
  renderBanner();
}

function handleScanExit(ev) {
  delete state.scans[ev.jobId];
  renderBanner();
  if (ev.code && ev.code !== 0 && ev.stderr) toast('A verificação terminou com erro: ' + ev.stderr.slice(0, 300), 10000);
  refreshBadge();
  if (['discos', 'relatorios'].includes(state.tab)) show(state.tab);
}

function handleHealthEvent(ev) {
  if (ev.kind !== 'fs') return;
  const hs = state.health[ev.volume] || (state.health[ev.volume] = { fs: null, lastLine: '' });
  if (ev.type === 'start') { hs.fs = 'running'; hs.lastLine = ''; }
  else if (ev.type === 'line') hs.lastLine = ev.line;
  else if (ev.type === 'end') { hs.fs = null; if (state.tab === 'discos') show('discos'); }
  renderBanner();
}

async function refreshBadge() {
  try {
    const n = await api.countEvents({ state: 'open', severity: 'error' });
    const b = $('#badge');
    if (n) { b.textContent = n > 99999 ? '99999+' : fmtNum(n); b.classList.remove('hidden'); } else b.classList.add('hidden');
  } catch (e) { /* ignora */ }
}

// ---------- Discos ----------
const kvRow = (label, ...value) => h('div', { class: 'kv' }, h('span', {}, label), h('b', {}, ...value));
const HEALTH_CHIP = { ok: ['íntegro', 'ok'], warn: ['atenção', 'warn'], problems: ['com problemas', 'err'] };

async function doVerifyFs(v) {
  if (isScanning(v.name)) { toast('Há uma verificação rodando neste disco. Pare-a ou espere terminar.'); return; }
  if (!confirm(`Checar o sistema de arquivos de "${v.name}"?\n\nO macOS vai desmontar o disco por alguns minutos (em 8 TB pode levar mais) e remontá-lo no final. Não desconecte o disco. Nada é gravado nem corrigido: é só uma checagem.\n\nFeche antes qualquer programa que esteja usando o disco.`)) return;
  const r = await api.verifyFs(v.name);
  if (!r.ok) { toast(r.error, 9000); return; }
  toast(r.summary, 15000);
  show('discos');
}

async function doEject(v) {
  let r = await api.ejectVolume(v.name);
  if (!r.ok && r.busy && r.holders && r.holders.length) {
    const groups = new Map();
    for (const p of r.holders) { const g = groups.get(p.label) || { pids: [], files: 0, killable: true }; g.pids.push(p.pid); g.files += p.files; g.killable = g.killable && p.killable; groups.set(p.label, g); }
    const lines = [...groups.entries()].slice(0, 12).map(([label, g]) => `• ${label}${g.pids.length > 1 ? ' ×' + g.pids.length : ''} (PID ${g.pids.slice(0, 3).join(', ')}${g.pids.length > 3 ? '…' : ''}) — ${fmtNum(g.files)} item(ns) abertos${g.killable ? '' : ' — o app não pode encerrar este'}`).join('\n');
    const killable = r.holders.filter((p) => p.killable).map((p) => p.pid);
    if (killable.length && confirm(`Estes programas estão usando "${v.name}" e impedem a ejeção:\n\n${lines}\n\nPedir que ${killable.length === r.holders.length ? 'eles terminem' : 'os que podem terminar, terminem'} (sem forçar) e tentar ejetar de novo?\n\nNão faça isso se algum estiver copiando arquivos para o disco.`)) {
      const k = await api.killHolders(v.name, killable);
      if (!k.ok) { toast(k.error, 9000); return; }
      r = await api.ejectVolume(v.name);
      if (!r.ok) toast('Ainda não foi possível ejetar' + (k.remaining.length ? ': ' + k.remaining.length + ' processo(s) não terminaram.' : '.') + '\n' + (r.error || ''), 14000);
    } else if (!killable.length) {
      toast('Quem está usando o disco:\n' + lines, 14000);
      return;
    } else return;
  }
  toast(r.ok ? `"${v.name}" ejetado. Já pode desconectar com segurança.` : r.error, r.ok ? 8000 : 14000);
  show('discos');
}

async function viewDiscos(root) {
  const vols = await api.listVolumes();
  root.append(
    h('h1', {}, 'Discos'),
    h('p', { class: 'sub' }, 'Escolha quais HDs monitorar. Para cada disco o app guarda uma "impressão digital" (hash) de cada arquivo e compara nas próximas verificações: se o conteúdo mudar sem você ter editado o arquivo, é corrupção.'));
  if (!vols.length) root.append(h('div', { class: 'note' }, 'Nenhum disco externo encontrado em ' + state.cfg.volumesRoot + '. Conecte os HDs e clique em Atualizar.'));
  const grid = h('div', { class: 'grid' });
  for (const v of vols) {
    const st = v.stats, info = v.info, jobId = v.jobs[0];
    const covered = pct(st.d90, st.files);
    const errs = st.openErrors, warns = st.openWarnings;
    const last = st.lastRun;
    const scanning = isScanning(v.name);
    const busy = scanning || isFsChecking(v.name) || v.busy;
    const fsc = st.lastFsCheck;
    const card = h('div', { class: 'card stack' + (v.offline ? ' offline' : '') },
      h('div', { class: 'row between' },
        h('div', {}, h('h3', {}, v.name), h('div', { class: 'muted small' }, v.offline ? 'Desconectado' : `${fmtBytes(v.used)} usados de ${fmtBytes(v.total)}`)),
        scanning ? chip('verificando…', 'gray') : !st.files ? chip('Sem inventário', 'gray') : errs ? chip(errs + ' problema(s)', 'err') : warns ? chip('Só avisos', 'warn') : chip('Tudo certo', 'ok')),
      !v.offline && v.total ? bar(pct(v.used, v.total)) : null,
      st.files ? h('div', { class: 'stack' },
        kvRow('Arquivos no inventário', fmtNum(st.files)),
        h('div', {},
          kvRow('Verificados nos últimos 90 dias', covered + '%'),
          bar(covered, covered >= 90 ? 'ok' : covered >= 40 ? '' : 'warn')),
        st.never ? kvRow('Ainda sem hash (1ª execução em andamento)', fmtNum(st.never)) : null,
        kvRow('Verificação mais antiga', st.oldestVerified ? fmtDate(st.oldestVerified) : '—'),
        kvRow('Última execução', last ? fmtDate(last.finished_at || last.started_at) + ' · ' + (STATUS[last.status] || [last.status])[0] : 'nunca'))
        : h('div', { class: 'muted small' }, 'Este disco ainda não foi catalogado. A primeira execução calcula o hash de todos os arquivos (para 8 TB leva cerca de 15 horas; ela pode ser dividida em várias noites e continua de onde parou).'),
      h('div', { class: 'stack hsec' },
        info ? kvRow('Formato', [info.fsType || '?', info.bus ? ' · ' + info.bus : '', info.solidState === false ? ' · HDD' : info.solidState ? ' · SSD' : ''].join('')) : null,
        kvRow('Sistema de arquivos', fsc ? [chip(fsc.status === 'ok' ? 'íntegro' : 'com problemas', fsc.status === 'ok' ? 'ok' : 'err'), ' ' + fmtDate(fsc.at)] : chip('nunca checado', 'warn'))),
      v.resume && !scanning && !v.offline ? h('div', { class: 'note' }, `A última verificação completa foi interrompida: ${fmtNum(v.resume.doneFiles)} arquivos (${fmtBytes(v.resume.doneBytes)}) já foram lidos; faltam ${fmtNum(v.resume.todoFiles)} (${fmtBytes(v.resume.todoBytes)}).`) : null,
      h('div', { class: 'actions' },
      v.resume && !scanning && !v.offline ? h('div', { class: 'btn-grid' },
        h('button', { class: 'btn primary', disabled: busy, title: 'Continua a verificação completa interrompida: pula os arquivos que já foram lidos desde que ela começou.', onclick: () => startScanFor(v, { full: true, resume: true }) }, 'Continuar de onde parou')) : null,
      h('div', { class: 'btn-grid' },
        h('button', { class: v.resume && !scanning ? 'btn' : 'btn primary', disabled: busy || v.offline, title: 'Lê 100% do disco desde o início, sem limite de horário. Independe da configuração do job.', onclick: () => startScanFor(v, { full: true }) }, 'Verificação completa'),
        h('button', { class: 'btn', disabled: busy || v.offline, title: 'Lê só os arquivos novos ou alterados (e os que já deram erro): use logo depois de copiar fotos para o disco.', onclick: () => startScanFor(v, { onlyNew: true }) }, 'Verificação das mudanças'),
        h('button', { class: 'btn', onclick: () => openSchedule(v) }, 'Agendamento')),
      h('div', { class: 'btn-grid' },
        h('button', { class: 'btn sm', disabled: busy || v.offline, onclick: () => doVerifyFs(v) }, 'Checar sistema de arquivos'),
        h('button', { class: 'btn sm', disabled: busy || v.offline, onclick: () => doEject(v) }, 'Ejetar'),
        errs || warns ? h('button', { class: 'btn sm', onclick: () => { state.report = { severity: errs ? 'error' : 'all', volume: v.name, runId: null, state: 'open' }; show('relatorios'); } }, 'Ver problemas') : null)));
    grid.append(card);
  }
  root.append(grid, h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => show('discos') }, 'Atualizar lista')));
}

// ---------- Jobs ----------
function viewJobs(root) {
  const jobs = state.cfg.jobs;
  if (!state.selectedJob || !jobs.find((j) => j.id === state.selectedJob)) state.selectedJob = jobs[0] && jobs[0].id;
  root.append(h('h1', {}, 'Jobs'), h('p', { class: 'sub' }, 'Um job define qual disco verificar, com que frequência e quanto do disco re-verificar a cada execução. Os jobs ativados rodam sozinhos (via launchd do macOS), mesmo com este app fechado.'));
  const list = h('div', { class: 'list' },
    jobs.map((j) => h('button', { class: j.id === state.selectedJob ? 'active' : '', onclick: () => { state.selectedJob = j.id; show('jobs'); } },
      h('div', {}, h('b', {}, j.name)), h('div', { class: 'muted small' }, j.volume + (state.cfg.scheduled[j.id] ? ' · agendado' : ' · manual')))),
    h('button', { onclick: async () => { const vols = await api.listVolumes(); const name = (vols[0] && vols[0].name) || 'Fotos'; const r = await api.createJob(name); state.cfg = r.config; state.selectedJob = r.job.id; show('jobs'); } }, '+ Novo job'));
  const job = jobs.find((j) => j.id === state.selectedJob);
  root.append(h('div', { class: 'split' }, list, job ? jobForm(job) : h('div', { class: 'note' }, 'Crie um job para começar.')));
}

function jobForm(job) {
  const f = {};
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  f.name = h('input', { type: 'text', value: job.name });
  f.volume = h('input', { type: 'text', value: job.volume, list: 'vols' });
  const dl = h('datalist', { id: 'vols' });
  api.listVolumes().then((vs) => vs.forEach((v) => dl.append(h('option', { value: v.name }))));
  f.enabled = h('input', { type: 'checkbox', checked: job.enabled });
  f.type = h('select', {}, h('option', { value: 'weekly', selected: job.schedule.type === 'weekly' }, 'Semanal'), h('option', { value: 'daily', selected: job.schedule.type === 'daily' }, 'Diária'));
  f.weekday = h('select', {}, DAYS.map((d, i) => h('option', { value: i, selected: Number(job.schedule.weekday) === i }, d)));
  f.time = h('input', { type: 'time', value: String(job.schedule.hour).padStart(2, '0') + ':' + String(job.schedule.minute).padStart(2, '0') });
  f.slice = h('input', { type: 'number', min: 1, max: 100, step: 0.5, value: job.slicePercent });
  f.hours = h('input', { type: 'number', min: 0, step: 0.5, value: job.maxMinutes ? job.maxMinutes / 60 : 0 });
  f.ignore = h('textarea', { placeholder: 'Um padrão por linha. Ex.:\n*.tmp\nLixo/**\n2008/Backup antigo' }, (job.ignore || []).join('\n'));
  f.validate = h('input', { type: 'checkbox', checked: job.validate !== false });
  f.emailOn = h('select', {},
    h('option', { value: 'issues', selected: job.emailOn === 'issues' }, 'Só quando houver problema'),
    h('option', { value: 'always', selected: job.emailOn === 'always' }, 'Sempre (resumo a cada execução)'),
    h('option', { value: 'never', selected: job.emailOn === 'never' }, 'Nunca'));
  const hint = h('div', { class: 'hint' });
  const weekdayField = field('Dia da semana', f.weekday);
  const typeField = field('Frequência', f.type), timeField = field('Horário', f.time);
  const sliceField = h('div', { class: 'field' }, h('label', {}, 'Fatia por execução agendada (% do disco)'), f.slice, hint);
  const hoursField = field('Limite de duração da execução agendada (horas, 0 = sem limite)', f.hours, 'Ao atingir o limite a execução termina com segurança e continua de onde parou na próxima. A "Verificação completa" manual não tem limite.');
  const upd = () => {
    const p = Math.max(1, Number(f.slice.value) || 12.5);
    const n = Math.ceil(100 / p);
    const daily = f.type.value === 'daily';
    hint.textContent = `Cada execução re-verifica ~${p}% do disco (os arquivos verificados há mais tempo primeiro) → o disco todo é coberto a cada ${n} execuções (~${daily ? n + ' dias' : n + ' semanas'}). Arquivos novos e alterados são sempre processados.`;
    weekdayField.classList.toggle('hidden', daily);
    // sem "Executar automaticamente" a agenda não é usada: campos desabilitados
    const sched = f.enabled.checked;
    for (const [el, box] of [[f.type, typeField], [f.weekday, weekdayField], [f.time, timeField], [f.slice, sliceField], [f.hours, hoursField]]) { el.disabled = !sched; box.classList.toggle('disabled-field', !sched); }
  };
  f.slice.addEventListener('input', upd); f.type.addEventListener('change', upd); f.enabled.addEventListener('change', upd);

  const collect = () => {
    const [hh, mm] = (f.time.value || '02:00').split(':').map(Number);
    return {
      ...job, name: f.name.value.trim() || 'Verificação', volume: f.volume.value.trim(), enabled: f.enabled.checked,
      schedule: { type: f.type.value, weekday: Number(f.weekday.value), hour: hh, minute: mm },
      slicePercent: Math.max(1, Math.min(100, Number(f.slice.value) || 12.5)),
      maxMinutes: Math.max(0, Math.round((Number(f.hours.value) || 0) * 60)),
      ignore: f.ignore.value.split('\n').map((s) => s.trim()).filter(Boolean),
      validate: f.validate.checked, emailOn: f.emailOn.value,
    };
  };
  const form = h('div', { class: 'form' },
    field('Nome', f.name),
    field('Disco', f.volume, 'Nome do volume em /Volumes (ex.: Fotos, Fotos_02).'), dl,
    h('div', { class: 'field' }, h('div', { class: 'check' }, f.enabled, h('div', {}, h('b', {}, 'Executar automaticamente'), h('div', { class: 'hint' }, 'Só para a execução agendada; as verificações manuais (botões da tela Discos) leem sempre 100% do disco, sem limite de horário. Agenda no macOS: se o Mac estiver dormindo no horário, roda quando acordar; se o disco não estiver conectado, pula e tenta na próxima.')))),
    typeField,
    weekdayField,
    timeField,
    sliceField,
    hoursField,
    field('Ignorar (opcional)', f.ignore),
    h('div', { class: 'field' }, h('div', { class: 'check' }, f.validate, h('div', {}, h('b', {}, 'Validar estrutura dos arquivos novos'), h('div', { class: 'hint' }, 'JPEG, PNG, RAW (DNG/CR2/ARW/TIFF), MP4/MOV e WAV: acusa arquivos vazios, truncados ou sem índice — já nascidos quebrados.')))),
    field('Avisar por e-mail', f.emailOn, 'Configure o servidor SMTP na aba Configurações.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: async () => {
        const j = collect();
        const r = await api.saveJob(j); state.cfg = r.config;
        toast(r.error || 'Job salvo' + (j.enabled ? ' e agendado.' : '.'), r.error ? 9000 : 4000);
        show('jobs');
      } }, 'Salvar'),
      h('button', { class: 'btn', disabled: isScanning(job.volume) || isFsChecking(job.volume), onclick: async () => { const r = await api.saveJob(collect()); state.cfg = r.config; startScan(job.id, { full: true }); } }, 'Salvar e verificar agora'),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Excluir o job "' + job.name + '"? (O inventário e os relatórios são mantidos.)')) return; state.cfg = await api.deleteJob(job.id); state.selectedJob = null; show('jobs'); } }, 'Excluir')));
  upd();
  return form;
}

// ---------- Relatórios ----------
async function viewReports(root) {
  const r = state.report;
  const runs = await api.listRuns(60);
  const health = await api.listHealth({ limit: 20 });
  const vols = [...new Set(state.cfg.jobs.map((j) => j.volume))];
  const flt = () => ({ state: r.state, severity: r.severity === 'all' ? null : r.severity, volume: r.volume || null, runId: r.runId, kind: r.kind || null, prefix: r.prefix || null });
  const events = await api.listEvents(flt());

  root.append(h('h1', {}, 'Relatórios'));
  const sel = (opts, cur, onch) => { const s = h('select', {}, opts.map(([v, t]) => h('option', { value: v, selected: String(cur) === String(v) }, t))); s.addEventListener('change', () => onch(s.value)); return s; };
  root.append(h('div', { class: 'filters' },
    sel([['open', 'Abertos'], ['resolved', 'Resolvidos'], ['all', 'Todos']], r.state, (v) => { r.state = v; show('relatorios'); }),
    sel([['error', 'Só erros'], ['warn', 'Só avisos'], ['all', 'Erros e avisos']], r.severity, (v) => { r.severity = v; show('relatorios'); }),
    sel([['', 'Todos os discos'], ...vols.map((v) => [v, v])], r.volume, (v) => { r.volume = v; show('relatorios'); }),
    sel([['', 'Todos os tipos'], ['missing', 'Arquivo sumiu']], r.kind, (v) => { r.kind = v; if (v === 'missing') { r.severity = 'all'; } show('relatorios'); }),
    h('input', { type: 'text', id: 'prefixFilter', placeholder: 'Pasta(s): 2014, 2015/Viagens', value: r.prefix || '', style: 'min-width:200px', onchange: (ev) => { r.prefix = ev.target.value; show('relatorios'); } }),
    r.runId ? h('button', { class: 'btn sm', onclick: () => { r.runId = null; show('relatorios'); } }, 'Execução #' + r.runId + ' ✕') : null,
    h('span', { style: 'flex:1' }),
    h('button', { class: 'btn sm', onclick: async () => { const x = await api.exportCsv(flt()); if (x.ok) toast(fmtNum(x.count) + ' registros exportados (os mesmos filtros da tela).'); } }, 'Exportar CSV')));

  const totalEvents = await api.countEvents(flt());
  if (r.kind === 'missing' && r.state === 'open' && totalEvents > 0) {
    root.append(h('div', { class: 'note', style: 'margin-bottom:10px' },
      h('span', {}, `${fmtNum(totalEvents)} arquivo(s) sumido(s) ${r.prefix ? 'em ' + r.prefix : 'neste filtro'}${r.volume ? ' (' + r.volume + ')' : ''}. `),
      h('button', { class: 'btn sm', id: 'bulkResolve', onclick: async () => {
        const { count } = await api.resolveBulk({ volume: r.volume || null, prefix: r.prefix || null, dryRun: true });
        if (!count) return;
        if (!confirm(`Marcar ${fmtNum(count)} arquivo(s) sumido(s) como apagados de propósito${r.prefix ? ' (pasta ' + r.prefix + ')' : ''}${r.volume ? ' no disco ' + r.volume : ' em TODOS os discos'}?`)) return;
        const x = await api.resolveBulk({ volume: r.volume || null, prefix: r.prefix || null });
        toast(fmtNum(x.count) + ' alerta(s) resolvido(s).'); show('relatorios'); refreshBadge();
      } }, 'Foi apagado de propósito — todos')));
  }
  if (totalEvents > events.length) root.append(h('div', { class: 'note' }, `Mostrando ${fmtNum(events.length)} de ${fmtNum(totalEvents)} registros (erros primeiro, mais recentes antes). Use "Exportar CSV" para a lista completa.`));

  if (!events.length) {
    root.append(h('div', { class: 'empty' }, r.state === 'open' ? '✓ Nenhum problema aberto com esses filtros.' : 'Nenhum registro com esses filtros.'));
  } else {
    const hasErr = events.some((e) => e.severity === 'error' && !e.resolved);
    if (hasErr) root.append(h('div', { class: 'note err', style: 'margin-bottom:10px' }, h('b', {}, 'Ação recomendada: '), 'restaure a versão anterior desses arquivos pela Backblaze o quanto antes (a retenção é de 1 ano). Depois de restaurar, rode a verificação: os alertas fecham sozinhos quando o arquivo volta ao normal.'));
    const rows = events.map((e) => {
      const acts = h('div', { class: 'row' });
      if (!e.resolved) {
        acts.append(h('button', { class: 'btn sm', onclick: async () => { const x = await api.reveal({ volume: e.volume, rel: e.path }); if (!x.ok) toast(x.error); else if (x.note) toast(x.note); } }, 'Mostrar no Finder'));
        if (e.kind === 'bitrot') acts.append(h('button', { class: 'btn sm', title: 'Eu editei o arquivo de propósito: aceitar o conteúdo atual como o novo original', onclick: async () => { if (confirm('Aceitar o conteúdo atual como o novo original? Só faça isso se tiver certeza de que o arquivo está bom.')) { await api.resolveEvents({ ids: [e.id], action: 'accept' }); show('relatorios'); refreshBadge(); } } }, 'Aceitar versão atual'));
        acts.append(h('button', { class: 'btn sm', onclick: async () => { await api.resolveEvents({ ids: [e.id], action: 'dismiss' }); show('relatorios'); refreshBadge(); } }, e.kind === 'missing' ? 'Foi apagado de propósito' : 'Ignorar'));
      } else acts.append(h('span', { class: 'muted small' }, (e.resolution || 'resolvido') + ' · ' + fmtDate(e.resolved_at)));
      return h('tr', {},
        h('td', {}, fmtDate(e.at)),
        h('td', {}, chip(KIND[e.kind] || e.kind, e.severity === 'error' ? 'err' : 'warn'), h('div', { class: 'muted small' }, e.volume)),
        h('td', { class: 'path' }, e.path, h('div', { class: 'muted' }, e.detail)),
        h('td', {}, acts));
    });
    root.append(h('table', {}, h('thead', {}, h('tr', {}, ['Quando', 'Tipo', 'Arquivo', 'Ações'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
  }

  root.append(h('h2', {}, 'Histórico de execuções'));
  if (!runs.length) root.append(h('div', { class: 'muted' }, 'Nenhuma execução ainda.'));
  else root.append(h('table', {},
    h('thead', {}, h('tr', {}, ['Início', 'Disco', 'Resultado', 'Duração', 'Lidos', 'Novos / alterados / sumidos', 'Problemas'].map((t) => h('th', {}, t)))),
    h('tbody', {}, runs.map((x) => {
      const [label, cls] = STATUS[x.status] || [x.status, 'gray'];
      return h('tr', { class: 'click', onclick: () => { state.report = { severity: 'all', volume: '', runId: x.id, state: 'all' }; show('relatorios'); } },
        h('td', {}, fmtDate(x.started_at)), h('td', {}, x.volume),
        h('td', {}, chip(label, cls), x.note ? h('div', { class: 'muted small' }, x.note) : null),
        h('td', {}, x.finished_at ? fmtDur(x.finished_at - x.started_at) : x.status === 'running' ? fmtDur(Date.now() - x.started_at) + ' …' : '—'),
        h('td', {}, `${fmtNum(x.files_hashed)} arq · ${fmtBytes(x.bytes_read)}` + (x.status === 'running' ? ' (ao vivo)' : '')),
        h('td', {}, `${fmtNum(x.files_new)} / ${fmtNum(x.files_changed)} / ${fmtNum(x.files_missing)}`),
        h('td', {}, x.issues ? h('b', {}, String(x.issues)) : '0'));
    }))));

  root.append(h('h2', {}, 'Saúde dos discos'));
  const KINDS = { fs: 'Sistema de arquivos' };
  const HCLS = { ok: ['ok', 'ok'], warn: ['atenção', 'warn'], problems: ['problemas', 'err'], busy: ['disco em uso', 'warn'], unavailable: ['indisponível', 'gray'], unknown: ['inconclusivo', 'gray'] };
  if (!health.length) root.append(h('div', { class: 'muted' }, 'Nenhuma checagem ainda. Use "Checar sistema de arquivos" na aba Discos.'));
  else root.append(h('table', {},
    h('thead', {}, h('tr', {}, ['Quando', 'Disco', 'Checagem', 'Resultado', 'Detalhes'].map((t) => h('th', {}, t)))),
    h('tbody', {}, health.map((x) => {
      const [label, cls] = HCLS[x.status] || [x.status, 'gray'];
      return h('tr', {},
        h('td', {}, fmtDate(x.at)), h('td', {}, x.volume), h('td', {}, KINDS[x.kind] || x.kind),
        h('td', {}, chip(label, cls)),
        h('td', {}, h('div', {}, x.summary || ''), x.output ? h('details', {}, h('summary', { class: 'muted small' }, 'ver saída completa'), h('pre', { class: 'out' }, x.output)) : null));
    }))));
}

// ---------- Configurações ----------
function viewSettings(root) {
  const c = state.cfg, s = c.smtp;
  const f = {
    host: h('input', { type: 'text', value: s.host, placeholder: 'smtp.gmail.com' }),
    port: h('input', { type: 'number', value: s.port }),
    secure: h('input', { type: 'checkbox', checked: s.secure }),
    user: h('input', { type: 'text', value: s.user, placeholder: 'voce@gmail.com' }),
    pass: h('input', { type: 'password', placeholder: s.passwordSet ? '•••••••• (salva no Keychain; deixe vazio para manter)' : 'senha de app' }),
    from: h('input', { type: 'text', value: s.from, placeholder: 'HD Checker <voce@gmail.com>' }),
    to: h('input', { type: 'email', value: s.to, placeholder: 'voce@gmail.com' }),
    backup: h('input', { type: 'text', value: c.backupDir || '', placeholder: 'Pasta coberta pela Backblaze (ex.: ~/Documents/hd_checker_backup)' }),
    conc: h('input', { type: 'number', min: 1, max: 8, value: c.concurrency }),
  };
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const collect = () => ({
    smtp: { ...s, host: f.host.value.trim(), port: Number(f.port.value) || 587, secure: f.secure.checked, user: f.user.value.trim(), from: f.from.value.trim(), to: f.to.value.trim() },
    smtpPassword: f.pass.value || null, backupDir: f.backup.value.trim() || null, concurrency: Number(f.conc.value) || 2,
  });
  const save = async () => { state.cfg = await api.saveSettings(collect()); f.pass.value = ''; toast('Configurações salvas.'); };

  root.append(
    h('h1', {}, 'Configurações'),
    h('h2', {}, 'Aviso por e-mail'),
    h('div', { class: 'form' },
      h('p', { class: 'sub' }, 'Com o Gmail: ative a verificação em duas etapas e crie uma "senha de app" em myaccount.google.com/apppasswords (servidor smtp.gmail.com, porta 587, sem SSL direto). A senha fica guardada no Keychain do macOS, não em arquivo.'),
      field('Servidor SMTP', f.host), field('Porta', f.port),
      h('div', { class: 'field' }, h('div', { class: 'check' }, f.secure, h('div', {}, 'Conexão SSL direta (porta 465). Deixe desmarcado para a porta 587 (STARTTLS).'))),
      field('Usuário', f.user), field('Senha', f.pass), field('Remetente (opcional)', f.from), field('Enviar para', f.to),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: save }, 'Salvar'),
        h('button', { class: 'btn', onclick: async () => { await save(); toast('Enviando e-mail de teste…', 20000); const r = await api.testEmail(); toast(r.ok ? 'E-mail de teste enviado! Confira sua caixa de entrada.' : 'Falhou: ' + r.error, 12000); } }, 'Salvar e enviar teste'))),
    h('h2', {}, 'Inventário (banco de dados)'),
    h('div', { class: 'form' },
      h('div', { class: 'kv' }, h('span', {}, 'Local do banco'), h('code', {}, c.resolvedDbPath)),
      h('p', { class: 'hint' }, 'Fica fora da pasta Documents de propósito: o iCloud pode corromper um SQLite em uso. Para proteger o inventário, o app copia o banco após cada execução para a pasta abaixo — escolha uma pasta que a Backblaze já cubra.'),
      field('Pasta de backup do inventário', f.backup),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder(); if (p) f.backup.value = p; } }, 'Escolher pasta…'),
        h('button', { class: 'btn', onclick: async () => { await save(); const r = await api.backupNow(); toast(r.ok ? 'Inventário copiado para ' + r.file : r.error, 8000); } }, 'Copiar agora')),
      h('div', { style: 'height:14px' }),
      field('Arquivos lidos em paralelo', f.conc, 'Em HD externo mecânico, 1 ou 2 é o ideal (leitura sequencial). SSD pode usar mais.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: save }, 'Salvar'))));
}

// ---------- navegação ----------
async function show(tab) {
  state.tab = tab;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  state.cfg = await api.getConfig();
  try { const v = await api.appVersion(); const el = document.getElementById('appVersion'); if (el && v) el.textContent = 'Versão ' + v; } catch (e) { /* sem versão */ }
  const root = h('div', {});
  try {
    if (tab === 'discos') await viewDiscos(root);
    else if (tab === 'jobs') viewJobs(root);
    else if (tab === 'relatorios') await viewReports(root);
    else viewSettings(root);
  } catch (e) { root.append(h('div', { class: 'note err' }, 'Erro: ' + e.message)); }
  if (state.tab === tab) $('#view').replaceChildren(root);
  refreshBadge();
}

document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'relatorios') state.report = { severity: 'error', volume: '', runId: null, state: 'open' };
  show(b.dataset.tab);
}));

api.onScanEvent(handleScanEvent);
api.onScanExit(handleScanExit);
api.onHealthEvent(handleHealthEvent);
api.scanStatus().then((list) => {
  (list || []).forEach((x) => { state.scans[x.jobId] = { phase: 'Em andamento…', plan: null, progress: null }; });
  renderBanner();
});
show('discos');

// Execuções agendadas rodam em outro processo: consulta o banco a cada poucos segundos para mostrá-las no topo.
async function pollBackground() {
  try {
    const list = await api.backgroundRuns();
    const before = state.bg.map((r) => r.id).join(','), after = (list || []).map((r) => r.id).join(',');
    state.bg = list || [];
    renderBanner();
    if (before !== after) { refreshBadge(); if (['discos', 'relatorios'].includes(state.tab)) show(state.tab); }
  } catch (e) { /* tenta de novo no próximo ciclo */ }
}
window.pollBackground = pollBackground;   // também usado pelos testes
pollBackground();
setInterval(pollBackground, 3000);

// Atualiza sozinho: execuções agendadas rodam em segundo plano e os números mudam ao vivo.
let tick = 0;
setInterval(() => {
  tick++;
  const a = document.activeElement;
  if (a && a.matches('select, input, textarea')) return;
  if (state.tab === 'relatorios' && (anyScan() || tick % 6 === 0)) show('relatorios');
  else if (state.tab === 'discos' && tick % 6 === 0) show('discos');
}, 5000);
