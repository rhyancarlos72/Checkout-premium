/**
 * Converte o link da aula no player certo: YouTube, Vimeo, Google Drive, Panda Video,
 * arquivo de vídeo direto (.mp4/.webm/.m3u8) ou qualquer outro link incorporável (iframe).
 */
export type VideoSource = { kind: 'iframe'; src: string } | { kind: 'file'; src: string } | null;

export function videoSource(raw?: string | null): VideoSource {
  const url = (raw ?? '').trim();
  if (!/^https:\/\//i.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  // YouTube (watch, youtu.be, shorts, embed, live)
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1)
        : u.searchParams.get('v') || u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{6,})/)?.[1] || '';
    if (/^[\w-]{6,}$/.test(id)) return { kind: 'iframe', src: `https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1` };
  }
  // Vimeo (vimeo.com/123, vimeo.com/123/hash, player.vimeo.com/video/123)
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(?:video\/)?(\d{5,})(?:\/([\da-f]+))?/);
    if (m) return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : u.search}` };
  }
  // Google Drive: /file/d/ID/view → /preview
  if (host === 'drive.google.com') {
    const id = u.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || u.searchParams.get('id');
    if (id) return { kind: 'iframe', src: `https://drive.google.com/file/d/${id}/preview` };
  }
  if (/\.(mp4|webm|ogg|m4v|mov)(\?|$)/i.test(u.pathname)) return { kind: 'file', src: url };
  // Panda Video, Bunny, Loom, Wistia etc.: o link de incorporação já é o player
  return { kind: 'iframe', src: url };
}
