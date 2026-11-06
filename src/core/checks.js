'use strict';
// Validação estrutural leve (lê só cabeçalho/rodapé/índices; não decodifica a imagem).
// Retorna null (ok) ou { level: 'error' | 'warn', code, detail }.
const fsp = require('fs/promises');
const path = require('path');

const MEDIA_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'dng', 'cr2', 'cr3', 'arw', 'nef', 'orf',
  'mp4', 'mov', 'm4v', 'wav', 'avi']);
const TIFF_EXT = new Set(['tif', 'tiff', 'dng', 'cr2', 'arw', 'nef', 'orf']);
const BMFF_EXT = new Set(['mp4', 'mov', 'm4v', 'cr3']);

const err = (code, detail) => ({ level: 'error', code, detail });
const warn = (code, detail) => ({ level: 'warn', code, detail });

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

async function tailAllZeros(fh, size) {
  const n = Math.min(size, 65536);
  if (size < 131072) return false;               // arquivos pequenos: não aplicar
  const t = await readAt(fh, size - n, n);
  for (let i = 0; i < t.length; i++) if (t[i] !== 0) return false;
  return true;
}

// Posição logo após o último byte diferente de zero (varre de trás para frente, no máximo maxBack bytes). -1 se só houver zeros nessa janela.
async function endOfData(fh, size, maxBack = 16 * 1024 * 1024) {
  const CH = 65536;
  let end = size;
  const stop = Math.max(0, size - maxBack);
  while (end > stop) {
    const start = Math.max(stop, end - CH);
    const b = await readAt(fh, start, end - start);
    for (let i = b.length - 1; i >= 0; i--) if (b[i] !== 0) return start + i + 1;
    end = start;
  }
  return -1;
}

// Procura o fim (FFD9) da imagem PRINCIPAL: dentro dos dados comprimidos de um JPEG, FF só aparece seguido de 00 ou RSTn,
// então o primeiro FFD9 depois do SOS é o EOI. Celulares (Xiaomi retrato, Samsung, Pixel...) anexam depois dele mapas de
// profundidade, imagens MPF, vídeo etc.; esses dados extras não fazem parte da foto.
async function findPrimaryEOI(fh, size, from) {
  const CH = 1024 * 1024;
  let pos = from, prevFF = false;
  while (pos < size) {
    const b = await readAt(fh, pos, Math.min(CH, size - pos));
    if (!b.length) break;
    if (prevFF && b[0] === 0xD9) return pos + 1;
    const i = b.indexOf(Buffer.from([0xFF, 0xD9]));
    if (i >= 0) return pos + i + 2;
    prevFF = b[b.length - 1] === 0xFF;
    pos += b.length;
  }
  return -1;
}

async function checkJpeg(fh, size) {
  if (size < 4) return err('jpeg_pequeno', 'arquivo menor que 4 bytes');
  const head = await readAt(fh, 0, 2);
  if (head[0] !== 0xFF || head[1] !== 0xD8) return err('jpeg_sem_SOI', 'não começa com o marcador JPEG (FFD8)');
  let pos = 2;
  let sawSOS = false, scanStart = 0;
  for (let n = 0; n < 500 && pos + 4 <= size; n++) {
    const b = await readAt(fh, pos, 4);
    if (b.length < 4 || b[0] !== 0xFF) break;
    const m = b[1];
    if (m === 0xFF) { pos += 1; continue; }
    if (m === 0xD9) break;
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01 || m === 0xD8) { pos += 2; continue; }
    if (m === 0xDA) { sawSOS = true; scanStart = pos + 2 + b.readUInt16BE(2); break; }
    pos += 2 + b.readUInt16BE(2);
  }
  if (!sawSOS) return err('jpeg_sem_dados', 'cabeçalho JPEG inválido: não encontrou o início dos dados da imagem');
  if (await tailAllZeros(fh, size)) {
    // Muitos celulares gravam o JPEG completo (com FFD9) e depois preenchem com zeros. Isso NÃO é corrupção.
    // Só é problema se os dados terminam no meio (sem FFD9 antes dos zeros): cópia interrompida.
    const e = await endOfData(fh, size);
    const last2 = e >= 2 ? await readAt(fh, e - 2, 2) : null;
    if (!last2 || last2[0] !== 0xFF || last2[1] !== 0xD9) {
      // pode haver dados extras do celular (mapa de profundidade etc.) depois da foto: se a imagem principal tem EOI, está íntegra
      if ((await findPrimaryEOI(fh, size, scanStart)) > 0) return null;
      return err('final_todo_zeros', 'os dados terminam no meio e o resto do arquivo é só zeros (cópia incompleta?)');
    }
    return null;
  }
  const n = Math.min(size, 4096);
  const tail = await readAt(fh, size - n, n);
  let e = tail.length;
  while (e > 0 && tail[e - 1] === 0) e--;
  if (e < 2 || tail[e - 2] !== 0xFF || tail[e - 1] !== 0xD9) {
    if ((await findPrimaryEOI(fh, size, scanStart)) > 0) return null;   // tem EOI da imagem principal; o que vem depois é dado extra do celular
    return warn('jpeg_sem_EOI', 'sem marcador de fim (FFD9): pode estar truncado (algumas câmeras antigas geram assim)');
  }
  return null;
}

async function checkPng(fh, size) {
  const sig = await readAt(fh, 0, 8);
  if (!sig.equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return err('png_cabecalho_invalido', 'assinatura PNG inválida');
  if (size < 20) return err('png_pequeno', 'PNG truncado');
  const t = await readAt(fh, size - 12, 12);
  if (t.subarray(4, 8).toString('latin1') !== 'IEND') return err('png_sem_IEND', 'PNG sem o bloco final IEND (truncado)');
  return null;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

async function checkTiff(fh, size, ext) {
  if (size < 16) return err('tiff_pequeno', 'arquivo menor que 16 bytes');
  const head = await readAt(fh, 0, 16);
  const le = head[0] === 0x49 && head[1] === 0x49;
  const be = head[0] === 0x4D && head[1] === 0x4D;
  if (!le && !be) return err('cabecalho_TIFF_invalido', 'cabeçalho TIFF/RAW inválido');
  const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const magic = u16(head, 2);
  if (magic === 43) return null;                                    // BigTIFF: não validado
  if (magic !== 42 && magic !== 0x4F52 && magic !== 0x5352 && magic !== 0x55) return err('cabecalho_TIFF_invalido', 'número mágico TIFF inesperado');
  if (magic !== 42) return null;                                    // ORF/RW2: só cabeçalho
  if (await tailAllZeros(fh, size)) return err('final_todo_zeros', 'últimos 64 KB são só zeros (cópia incompleta?)');

  const queue = [u32(head, 4)];
  const visited = new Set();
  let maxEnd = 0;
  let ifdCount = 0;
  while (queue.length && ifdCount < 24) {
    const off = queue.shift();
    if (!off || visited.has(off)) continue;
    visited.add(off);
    ifdCount++;
    if (off + 2 > size) return err('tiff_ifd_fora', `IFD em ${off} fora do arquivo (${size} bytes): truncado`);
    const cnt = u16(await readAt(fh, off, 2), 0);
    if (cnt === 0 || cnt > 2000) return err('tiff_ifd_invalido', `IFD com ${cnt} entradas`);
    if (off + 2 + cnt * 12 + 4 > size) return err('tiff_ifd_fora', 'IFD ultrapassa o fim do arquivo: truncado');
    const eb = await readAt(fh, off + 2, cnt * 12 + 4);
    const arrays = {};
    for (let i = 0; i < cnt; i++) {
      const o = i * 12;
      const tag = u16(eb, o), type = u16(eb, o + 2), count = u32(eb, o + 4);
      const ts = TYPE_SIZE[type];
      if (!ts) continue;
      const wanted = [273, 279, 324, 325, 513, 514, 330].includes(tag);
      if (!wanted || count === 0 || count > 400000) continue;
      const total = ts * count;
      let vb;
      if (total <= 4) vb = eb.subarray(o + 8, o + 8 + total);
      else {
        const vo = u32(eb, o + 8);
        if (vo + total > size) return err('tiff_valor_fora', `tabela da tag ${tag} fora do arquivo: truncado`);
        vb = await readAt(fh, vo, total);
      }
      const vals = [];
      for (let k = 0; k < count; k++) {
        vals.push(ts === 2 ? u16(vb, k * 2) : ts === 4 ? u32(vb, k * 4) : vb[k]);
      }
      arrays[tag] = vals;
    }
    if (arrays[330]) arrays[330].forEach((s) => queue.push(s));      // SubIFDs (DNG: dados RAW)
    const next = u32(eb, cnt * 12);
    if (next) queue.push(next);
    for (const [o, c] of [[273, 279], [324, 325], [513, 514]]) {
      const offs = arrays[o], cnts = arrays[c];
      if (offs && cnts) {
        for (let i = 0; i < Math.min(offs.length, cnts.length); i++) maxEnd = Math.max(maxEnd, offs[i] + cnts[i]);
      }
    }
  }
  if (maxEnd > size) return err('tiff_truncado', `os dados da imagem terminam em ${maxEnd} mas o arquivo tem só ${size} bytes (truncado)`);
  return null;
}

const KNOWN_FIRST = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'junk', 'uuid', 'prfl', 'pict', 'free']);

async function checkBmff(fh, size) {
  let pos = 0, n = 0, hasMoov = false, first = null;
  while (pos < size && n < 200000) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return err('mp4_atom_truncado', `arquivo termina no meio de um bloco (posição ${pos})`);
    let sz = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    if (n === 0) { first = type; if (!KNOWN_FIRST.has(type)) return null; }   // formato antigo/desconhecido: não julgar
    if (sz === 1) {
      if (h.length < 16) return err('mp4_atom_truncado', 'cabeçalho de bloco incompleto');
      sz = Number(h.readBigUInt64BE(8));
    } else if (sz === 0) sz = size - pos;
    if (sz < 8) return err('mp4_atom_invalido', `bloco "${type}" com tamanho inválido (${sz})`);
    if (type === 'moov') hasMoov = true;
    pos += sz; n++;
  }
  if (pos > size) return err('mp4_truncado', `blocos somam ${pos} bytes mas o arquivo tem ${size} (truncado)`);
  if (!hasMoov) return err('mp4_sem_moov', 'sem o índice "moov": vídeo não reproduzível (gravação interrompida ou cópia incompleta)');
  if (pos < size) return warn('mp4_lixo_no_fim', `${size - pos} bytes extras após o último bloco`);
  return null;
}

async function checkRiff(fh, size) {
  const h = await readAt(fh, 0, 12);
  if (h.length < 12 || h.subarray(0, 4).toString('latin1') !== 'RIFF') return err('riff_cabecalho_invalido', 'cabeçalho RIFF inválido');
  const declared = h.readUInt32LE(4) + 8;
  if (declared > size + 1) return err('riff_truncado', `cabeçalho declara ${declared} bytes mas o arquivo tem ${size} (truncado)`);
  return null;
}

async function validate(absPath, size, ext) {
  ext = ext.toLowerCase();
  if (!MEDIA_EXT.has(ext)) return null;
  if (size === 0) return err('zero_bytes', 'arquivo vazio (0 bytes)');
  const fh = await fsp.open(absPath, 'r');
  try {
    if (ext === 'jpg' || ext === 'jpeg') return await checkJpeg(fh, size);
    if (ext === 'png') return await checkPng(fh, size);
    if (TIFF_EXT.has(ext)) return await checkTiff(fh, size, ext);
    if (BMFF_EXT.has(ext)) {
      const r = await checkBmff(fh, size);
      if (r) return r;
      return (await tailAllZeros(fh, size)) ? err('final_todo_zeros', 'últimos 64 KB são só zeros') : null;
    }
    if (ext === 'wav' || ext === 'avi') return await checkRiff(fh, size);
  } finally {
    await fh.close();
  }
  return null;
}

const extOf = (p) => path.extname(p).slice(1).toLowerCase();

module.exports = { validate, extOf, MEDIA_EXT };
