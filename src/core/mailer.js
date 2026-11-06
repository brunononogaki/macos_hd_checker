'use strict';
const { getSmtpPassword } = require('./secrets');

const KIND_LABEL = {
  bitrot: 'CORRUPÇÃO SILENCIOSA (conteúdo mudou)',
  estrutura: 'Arquivo com estrutura inválida',
  ilegivel: 'Erro de leitura do disco',
  missing: 'Arquivo sumiu',
};

const fmtBytes = (n) => {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' TB';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return Math.round(n / 1e3) + ' KB';
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildMessage(result) {
  const { job, stats, status, newIssues, coverage } = result;
  const errors = newIssues.filter((i) => i.severity === 'error');
  const missing = newIssues.filter((i) => i.kind === 'missing');
  const warns = newIssues.filter((i) => i.severity !== 'error' && i.kind !== 'missing');
  const statusPt = { ok: 'sem problemas', issues: 'com problemas', partial: 'parcial (limite de tempo)', stopped: 'interrompida', error: 'falhou', skipped: 'não executada' }[status] || status;
  let subject;
  if (errors.length) subject = `⚠️ HD Checker: ${errors.length} arquivo(s) com problema em "${job.volume}"`;
  else if (missing.length) subject = `HD Checker: ${missing.length} arquivo(s) sumiram de "${job.volume}"`;
  else if (status === 'error') subject = `HD Checker: a verificação de "${job.volume}" falhou`;
  else subject = `HD Checker: "${job.volume}" verificado — ${statusPt}`;

  const lines = [];
  lines.push(`Disco: ${job.volume}   |   Job: ${job.name}   |   Resultado: ${statusPt}`);
  lines.push(`Arquivos no disco: ${stats.total}   |   lidos nesta execução: ${stats.hashed} (${fmtBytes(stats.bytes)})`);
  lines.push(`Novos: ${stats.new}   |   alterados: ${stats.changed}   |   movidos: ${stats.moved}   |   sumidos: ${stats.missing}`);
  if (result.note) lines.push(result.note);
  lines.push('');
  const list = (title, arr, max = 40) => {
    if (!arr.length) return;
    lines.push(`${title} (${arr.length})`);
    for (const i of arr.slice(0, max)) lines.push(`  • [${KIND_LABEL[i.kind] || i.kind}] ${i.path}\n      ${i.detail}`);
    if (arr.length > max) lines.push(`  … e mais ${arr.length - max}. Veja todos no app (aba Relatórios).`);
    lines.push('');
  };
  list('PROBLEMAS', errors);
  list('ARQUIVOS QUE SUMIRAM', missing);
  list('AVISOS', warns, 15);
  if (errors.length) {
    lines.push('O QUE FAZER: restaure a versão anterior desses arquivos pela Backblaze AGORA (a retenção é de 1 ano),');
    lines.push('e depois rode a verificação de novo — o app marca como resolvido quando o arquivo é restaurado.');
    lines.push('');
  }
  if (coverage) {
    const pct = (n) => (coverage.files ? Math.round((n / coverage.files) * 100) : 0);
    lines.push(`Cobertura do inventário: ${pct(coverage.d90)}% verificado nos últimos 90 dias, ${pct(coverage.d365)}% no último ano; ${coverage.never} arquivo(s) ainda sem hash.`);
  }
  const text = lines.join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#222">` +
    esc(text).replace(/\n/g, '<br>').replace(/ /g, '&nbsp;').replace(/&nbsp;&nbsp;/g, '&nbsp;&nbsp;') + `</div>`;
  return { subject, text, html };
}

async function sendMail(cfg, msg) {
  const s = cfg.smtp || {};
  if (!s.host || !s.to) throw new Error('SMTP não configurado (servidor/destinatário).');
  const nodemailer = require('nodemailer');
  const pass = getSmtpPassword(s.user);
  const transport = nodemailer.createTransport({
    host: s.host, port: Number(s.port) || 587, secure: !!s.secure,
    auth: s.user ? { user: s.user, pass: pass || '' } : undefined,
  });
  return transport.sendMail({ from: s.from || s.user, to: s.to, subject: msg.subject, text: msg.text, html: msg.html });
}

async function sendRunEmail(cfg, result) {
  return sendMail(cfg, buildMessage(result));
}

async function sendTestEmail(cfg) {
  return sendMail(cfg, {
    subject: 'HD Checker: e-mail de teste',
    text: 'Se você recebeu esta mensagem, as notificações do HD Checker estão funcionando.',
    html: '<p>Se você recebeu esta mensagem, as notificações do HD Checker estão funcionando.</p>',
  });
}

module.exports = { buildMessage, sendRunEmail, sendTestEmail };
