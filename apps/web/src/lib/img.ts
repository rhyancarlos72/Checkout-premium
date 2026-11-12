/**
 * Miniatura de uma imagem do Storage (o servidor gera um WebP do tamanho certo e guarda em cache).
 * Use para imagens exibidas pequenas (order bump, foto do produto, avatar). Banner e logo usam a original.
 * Imagens de fora do Storage ficam como estão.
 */
const STORAGE = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/storage\/v1\/object\/public\/[\w\-./%]+\.(webp|png|jpe?g|gif|avif)$/i;

export function thumbUrl(url: string | null | undefined, width: number) {
  if (!url || !STORAGE.test(url)) return url ?? undefined;
  return `/api/public/img?w=${Math.round(width)}&src=${encodeURIComponent(url)}`;
}

/** src + srcSet (1x e 2x) para uma imagem exibida com `cssPx` de largura/altura. */
export function thumbProps(url: string | null | undefined, cssPx: number) {
  if (!url || !STORAGE.test(url)) return { src: url ?? undefined };
  const one = thumbUrl(url, cssPx)!;
  const two = thumbUrl(url, cssPx * 2)!;
  return { src: two, srcSet: `${one} 1x, ${two} 2x` };
}
