import crypto from 'node:crypto';

/** Retire EXIF/XMP/IPTC/commentaires d'un JPEG sans ré-encoder l'image. Retourne null si ce n'est pas un JPEG. */
export function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { // début des données image : tout le reste est copié tel quel
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    // APP1 (EXIF/XMP), APP12/13 (IPTC/Photoshop), APP14+, COM : supprimés. APP0 (JFIF) et APP2 (profil ICC) conservés.
    const drop = marker === 0xe1 || (marker >= 0xeb && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(seg);
    i += 2 + len;
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD']);

/** Ne conserve que les blocs PNG nécessaires à l'affichage (supprime eXIf, tEXt, iTXt, tIME…). */
export function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out = [PNG_SIG];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const chunk = buf.subarray(i, i + 12 + len);
    if (PNG_KEEP.has(type)) out.push(chunk);
    i += 12 + len;
  }
  return Buffer.concat(out);
}

/** Nettoie une photo reçue ; retourne { buffer, ext, hash } ou null si le format n'est pas pris en charge. */
export function sanitizePhoto(buf) {
  let clean = stripJpeg(buf);
  let ext = 'jpg';
  if (!clean) {
    clean = stripPng(buf);
    ext = 'png';
  }
  if (!clean) return null;
  return { buffer: clean, ext, hash: crypto.createHash('sha256').update(clean).digest('hex') };
}

export function audioExtension(mimetype = '', filename = '') {
  let m = mimetype.toLowerCase();
  // certains clients mobiles n'envoient pas de type MIME : on se rabat sur l'extension du fichier
  if (!m.startsWith('audio/') && /\.(m4a|aac|mp4|wav|ogg|webm|mp3)$/i.test(filename)) m = `audio/${filename.split('.').pop().toLowerCase()}`;
  if (!m.startsWith('audio/')) return null;
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'm4a';
}
