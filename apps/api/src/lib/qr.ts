import QRCode from 'qrcode';

/** QR Code do Pix (PNG em data URL) gerado localmente a partir do copia e cola — leva poucos milissegundos. */
export async function pixQrDataUrl(pixCode: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(pixCode, { errorCorrectionLevel: 'M', margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } });
  } catch {
    return null;
  }
}
