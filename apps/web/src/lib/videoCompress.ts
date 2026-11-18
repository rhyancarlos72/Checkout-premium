/**
 * Compressão do vídeo da página de vendas NO NAVEGADOR (biblioteca mediabunny, usa o processador de vídeo do
 * computador — nada pesa no servidor). Gera:
 *  - HD: MP4 H.264 até 720p (~1,2 Mbps) + áudio AAC 96 kbps, com "fast start" (começa a tocar antes de baixar tudo)
 *  - SD: a mesma coisa em 480p (~550 kbps), para internet fraca no celular
 *  - capa: imagem JPG do 1º segundo (aparece na hora, antes do vídeo carregar)
 * O tamanho final fica abaixo de ~45 MB por arquivo (limite do armazenamento); vídeos longos ganham bitrate menor.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, Conversion, Input, Mp4OutputFormat, Output, canEncodeAudio, canEncodeVideo } from 'mediabunny';

const MAX_BYTES = 45 * 1024 * 1024;
const AUDIO_BPS = 96_000;

export type CompressStep = 'hd' | 'sd' | 'poster';
export interface CompressResult {
  hd: Blob;
  sd: Blob | null;
  poster: Blob | null;
  duration: number;
  width: number;
  height: number;
}

/** O navegador consegue converter? (Chrome/Edge/Safari recentes: sim) */
export async function canCompress() {
  try {
    return typeof VideoEncoder !== 'undefined' && (await canEncodeVideo('avc'));
  } catch {
    return false;
  }
}

/** bitrate que cabe no limite de tamanho para a duração do vídeo */
const fitBitrate = (wanted: number, seconds: number) => Math.max(250_000, Math.min(wanted, Math.floor((MAX_BYTES * 8 * 0.95) / Math.max(1, seconds) - AUDIO_BPS)));

/** Áudio: AAC 96 kbps quando o navegador codifica AAC; senão, copia o áudio original (vídeos de celular já vêm em AAC). */
let aacOk: Promise<boolean> | null = null;
const canAac = () => (aacOk ??= canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48_000, bitrate: AUDIO_BPS }).catch(() => false));

async function convert(file: File, maxHeight: number, bitrate: number, onProgress: (p: number) => void) {
  const aac = await canAac();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const conversion = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: (track) => {
      const h = track.displayHeight;
      return {
        codec: 'avc',
        bitrate,
        ...(h > maxHeight ? { height: maxHeight } : {}), // mantém a proporção; nunca aumenta
        frameRate: 30,
        keyFrameInterval: 2,
        forceTranscode: true,
      };
    },
    audio: aac ? { codec: 'aac', bitrate: AUDIO_BPS, numberOfChannels: 2, sampleRate: 48_000, forceTranscode: true } : {},
  });
  if (!conversion.isValid) throw new Error('Este vídeo não pôde ser convertido neste navegador. Tente pelo Chrome no computador.');
  conversion.onProgress = (p) => onProgress(p);
  await conversion.execute();
  return new Blob([target.buffer!], { type: 'video/mp4' });
}

/** Capa: quadro do 1º segundo, até 1280 px de largura, JPG. */
async function posterFrom(file: File): Promise<Blob | null> {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const sink = new CanvasSink(track, { width: Math.min(1280, track.displayWidth), fit: 'contain' });
    const start = await track.getFirstTimestamp();
    const dur = await track.computeDuration();
    const frame = await sink.getCanvas(Math.min(start + 1, start + dur / 2));
    if (!frame) return null;
    const c = frame.canvas as HTMLCanvasElement | OffscreenCanvas;
    if ('convertToBlob' in c) return await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return await new Promise<Blob | null>((ok) => (c as HTMLCanvasElement).toBlob(ok, 'image/jpeg', 0.8));
  } catch {
    return null;
  }
}

/**
 * Converte o vídeo: HD (720p), SD (480p) e capa.
 * onProgress(etapa, 0..1) para a barra de progresso do painel.
 */
export async function compressVideo(file: File, onProgress: (step: CompressStep, p: number) => void): Promise<CompressResult> {
  const probe = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track) throw new Error('Não encontrei vídeo neste arquivo.');
  const duration = await probe.computeDuration();
  const width = track.displayWidth;
  const height = track.displayHeight;

  const hd = await convert(file, 720, fitBitrate(1_200_000, duration), (p) => onProgress('hd', p));
  // SD só vale a pena se o original for maior que 480p
  const sd = height > 480 ? await convert(file, 480, fitBitrate(550_000, duration), (p) => onProgress('sd', p)) : null;
  onProgress('poster', 0);
  const poster = await posterFrom(file);
  onProgress('poster', 1);
  return { hd, sd, poster, duration, width, height };
}
