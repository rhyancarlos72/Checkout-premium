/**
 * Otimiza a imagem NO NAVEGADOR antes do upload: redimensiona para o tamanho em que ela aparece
 * no checkout (com folga para telas retina) e converte para WebP. Uma foto de 3 MB vira ~100 KB.
 * SVG e GIF (animação) passam como estão. Se a versão otimizada não ficar menor, mantém o original.
 * Devolve também largura/altura finais (usadas para reservar o espaço e evitar "pulos" na página).
 */
export async function optimizeImage(file: File, maxW: number, maxH: number, quality = 0.82): Promise<{ file: File; width?: number; height?: number }> {
  if (!/^image\/(jpeg|png|webp|bmp)$/.test(file.type)) return { file };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { file };
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/webp', quality));
    if (!blob || blob.type !== 'image/webp') return { file, width: scale === 1 ? width : undefined, height: scale === 1 ? height : undefined };
    if (blob.size >= file.size && scale === 1) return { file, width, height };
    return { file: new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' }), width, height };
  } catch {
    return { file };
  }
}

/** Tamanhos máximos por uso (px), já com folga para telas retina. */
export const IMAGE_SIZES = {
  banner: [1600, 1600],
  thumb: [480, 480], // produto, order bump, upsell (aparecem com até ~100 px)
  logo: [600, 200],
  avatar: [160, 160],
} as const;
export type ImageKind = keyof typeof IMAGE_SIZES;

/** Lê as dimensões gravadas no fim da URL (#w=1200&h=675) para reservar o espaço da imagem. */
export function imageDims(url?: string | null): { width?: number; height?: number } {
  const m = url?.match(/#w=(\d+)&h=(\d+)$/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}
