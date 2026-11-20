import crypto from 'node:crypto';
import { HttpError, supabase } from '../lib/core.js';

/**
 * PDFs da área de membros: o painel cola um link do Google Drive e o servidor baixa o arquivo e guarda
 * uma cópia na área privada (bucket "deliverables"). O aluno recebe um link temporário (ver memberModule).
 * Só endereços do Google Drive são aceitos (o servidor nunca baixa de um endereço qualquer).
 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** endereço de download do Drive (trocado nos testes) */
export const driveCfg = { base: 'https://drive.usercontent.google.com' };

/** Id do arquivo num link do Drive (…/file/d/ID/…, …?id=ID). null = não é link de arquivo do Drive. */
export function driveFileId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/^(drive|docs)\.google\.com$/.test(u.hostname)) return null;
  const id = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,200})/)?.[1] ?? u.searchParams.get('id');
  return id && /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
}

/** Nome do arquivo no cabeçalho do Drive (Content-Disposition), sem a extensão. */
function fileName(cd: string | null) {
  const star = cd?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = cd?.match(/filename="?([^";]+)"?/i)?.[1];
  let n = '';
  try {
    n = star ? decodeURIComponent(star) : (plain ?? '');
  } catch {
    n = plain ?? '';
  }
  return n.replace(/\.pdf$/i, '').trim().slice(0, 120) || null;
}

const NOT_SHARED = 'Não consegui baixar o PDF do Drive. No Drive, clique em Compartilhar → "Qualquer pessoa com o link" e tente de novo (ou use "Enviar PDF").';

export async function importDrivePdf(url: string, orgPrefix: string) {
  const id = driveFileId(url);
  if (!id) throw new HttpError(400, 'Use um link de arquivo do Google Drive (drive.google.com/file/d/…)');
  let r: Response;
  try {
    r = await fetch(`${driveCfg.base}/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new HttpError(502, 'O Google Drive não respondeu. Tente de novo em instantes.');
  }
  if (!r.ok || !r.body) throw new HttpError(400, NOT_SHARED);
  if (Number(r.headers.get('content-length') ?? 0) > MAX_PDF_BYTES) throw new HttpError(400, 'PDF acima de 50 MB');
  // lê com limite de tamanho (não confia no cabeçalho)
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PDF_BYTES) {
      await reader.cancel().catch(() => {});
      throw new HttpError(400, 'PDF acima de 50 MB');
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  // arquivo não compartilhado: o Drive devolve uma página de login (HTML), não o PDF
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, NOT_SHARED);
  const path = `${orgPrefix}members/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.pdf`;
  const { error } = await supabase.storage.from('deliverables').upload(path, buf, { contentType: 'application/pdf', upsert: false });
  if (error) throw new HttpError(502, `Não foi possível guardar o PDF: ${error.message}`);
  return { file: path, name: fileName(r.headers.get('content-disposition')), size };
}
