import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button, Field } from './ui';

/** Upload para o Supabase Storage (bucket `media`, público) — exige usuário admin (RLS). */
export function ImageUpload({ value, onChange, label, bucket = 'media', accept = 'image/*' }: { value?: string | null; onChange: (url: string) => void; label?: string; bucket?: string; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(file: File) {
    setErr(null);
    if (file.size > 5 * 1024 * 1024 && bucket === 'media') return setErr('Imagem acima de 5 MB');
    setBusy(true);
    const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from(bucket).upload(path, file, { cacheControl: '31536000', upsert: false, contentType: file.type });
    setBusy(false);
    if (error) return setErr(error.message);
    onChange(bucket === 'media' ? supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl : path);
  }

  const isImage = accept.startsWith('image');
  return (
    <Field label={label} error={err ?? undefined}>
      <div className="flex items-center gap-3">
        {isImage && value ? (
          <img src={value} alt="" className="h-16 w-16 rounded-xl border border-gray-200 object-cover" />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-dashed border-gray-300 text-gray-400">
            <Upload className="h-5 w-5" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => ref.current?.click()}>
              {value ? 'Trocar' : 'Enviar arquivo'}
            </Button>
            {value && (
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
                Remover
              </Button>
            )}
          </div>
          {value && !isImage && <span className="truncate text-xs text-gray-500">{value}</span>}
        </div>
      </div>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
    </Field>
  );
}

