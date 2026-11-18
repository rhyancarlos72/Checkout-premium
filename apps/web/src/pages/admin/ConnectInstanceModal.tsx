import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Modal } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { maskPhone } from '@/lib/format';

type Toast = { ok: (m: string) => void; err: (m: string) => void };
interface Conn { ok: boolean; connected?: boolean; qr?: string | null; pairingCode?: string | null; number?: string | null; profileName?: string | null; error?: string; hint?: string }

const fmt = (n?: string | null) => (n && n.length >= 12 ? `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, -4)}-${n.slice(-4)}` : n ?? '');

/**
 * Conectar um número novo sem sair do checkout:
 * cria a instância na Evolution → mostra o QR Code aqui → ao ler no WhatsApp, a instância
 * (nome + token) já entra no rodízio do checkout.
 */
export function ConnectInstanceModal({ existing, onClose, toast, reconnect }: { existing: string[]; onClose: () => void; toast: Toast; /** nome da instância que caiu: reconecta em vez de criar outra */ reconnect?: string }) {
  const qc = useQueryClient();
  const suggestion = (() => {
    for (let i = existing.length + 1; i < 99; i++) if (!existing.includes(`checkout${i}`)) return `checkout${i}`;
    return 'checkout';
  })();
  const [name, setName] = useState(reconnect ?? suggestion);
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'form' | 'qr' | 'done'>('form');
  const [conn, setConn] = useState<Conn | null>(null);
  const [err, setErr] = useState<{ error: string; hint?: string } | null>(null);
  const created = useRef<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      reconnect
        ? adminApi.post<Conn & { name?: string }>(`/whatsapp/instances/${encodeURIComponent(reconnect)}/reconnect`, { number: phone || null })
        : adminApi.post<Conn & { name?: string }>('/whatsapp/instances', { name, number: phone || null }),
    onSuccess: (r) => {
      if (!r.ok) return setErr({ error: r.error ?? (reconnect ? 'Não foi possível reconectar' : 'Não foi possível criar'), hint: r.hint });
      created.current = name;
      setErr(null);
      setConn(r);
      if (r.connected) {
        setStep('done'); // já estava conectada
        qc.invalidateQueries({ queryKey: ['whatsapp'] });
        return;
      }
      setStep('qr');
      qc.invalidateQueries({ queryKey: ['whatsapp'] });
    },
    onError: (e) => setErr({ error: e instanceof ApiError ? e.message : reconnect ? 'Erro ao reconectar' : 'Erro ao criar a instância' }),
  });

  // consulta a cada 3 s: QR atualizado (expira em ~40 s) e se já conectou
  useEffect(() => {
    if (step !== 'qr' || !created.current) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await adminApi.get<Conn>(`/whatsapp/instances/${encodeURIComponent(created.current!)}/connect${phone ? `?number=${encodeURIComponent(phone)}` : ''}`);
        if (stop) return;
        if (!r.ok) return setErr({ error: r.error ?? 'Falha ao consultar a Evolution', hint: r.hint });
        setErr(null);
        if (r.connected) {
          setConn(r);
          setStep('done');
          qc.invalidateQueries({ queryKey: ['whatsapp'] });
          toast.ok(`WhatsApp conectado${r.number ? `: ${fmt(r.number)}` : ''}`);
          return;
        }
        setConn((c) => ({ ...c, ...r, qr: r.qr ?? c?.qr ?? null }));
      } catch {
        /* tenta de novo no próximo ciclo */
      }
    };
    const id = setInterval(tick, 3000);
    return () => ((stop = true), clearInterval(id));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open onClose={onClose} title={reconnect ? `Reconectar WhatsApp · ${reconnect}` : 'Conectar novo número do WhatsApp'}>
      {step === 'form' && reconnect && (
        <div className="space-y-4">
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            O WhatsApp da instância <b className="font-mono">{reconnect}</b> desconectou. Gere um QR Code novo e leia com o celular <b>do mesmo número</b> (ou use o código de conexão). A instância continua com o mesmo nome e token, sem mexer em mais nada.
          </p>
          <Field label="Número do WhatsApp (opcional)" hint="Se informar, também aparece um código para conectar sem câmera: WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone.">
            <Input value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} inputMode="tel" placeholder="(11) 99999-9999" />
          </Field>
          {err && (
            <div className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
              {err.error}
              {err.hint && <p className="mt-1 text-xs text-zinc-600">💡 {err.hint}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}><QrCode className="h-4 w-4" /> Gerar QR Code</Button>
          </div>
        </div>
      )}
      {step === 'form' && !reconnect && (
        <div className="space-y-4">
          <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">O checkout cria a instância na sua Evolution e mostra o QR Code aqui. É só ler com o WhatsApp do número novo: a instância entra sozinha no rodízio de envios.</p>
          <Field label="Nome da instância" hint="Sem espaços. Ex.: checkout6, vendas02">
            <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} className="font-mono" maxLength={40} />
          </Field>
          <Field label="Número do WhatsApp (opcional)" hint="Se informar, também aparece um código para conectar sem câmera (Aparelhos conectados → Conectar com número).">
            <Input value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} inputMode="tel" placeholder="(11) 99999-9999" />
          </Field>
          {err && (
            <div className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
              {err.error}
              {err.hint && <p className="mt-1 text-xs text-zinc-600">💡 {err.hint}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button loading={create.isPending} disabled={name.length < 2} onClick={() => create.mutate()}><QrCode className="h-4 w-4" /> Criar e gerar QR Code</Button>
          </div>
        </div>
      )}

      {step === 'qr' && (
        <div className="space-y-4 text-center">
          <p className="text-sm text-zinc-600">{reconnect ? <>Instância <b className="font-mono text-zinc-900">{created.current}</b>: no celular do número que estava conectado:</> : <>Instância <b className="font-mono text-zinc-900">{created.current}</b> criada. Agora, no celular do número novo:</>}</p>
          <ol className="mx-auto max-w-sm space-y-1 text-left text-sm text-zinc-600">
            <li>1. Abra o WhatsApp → <b>Configurações</b> → <b>Aparelhos conectados</b></li>
            <li>2. Toque em <b>Conectar um aparelho</b></li>
            <li>3. Aponte a câmera para o QR Code abaixo</li>
          </ol>
          <div className="mx-auto flex h-64 w-64 items-center justify-center rounded-2xl bg-[#fff] p-3 shadow-sm ring-1 ring-zinc-200">
            {conn?.qr ? <img src={conn.qr} alt="QR Code do WhatsApp" className="h-full w-full" /> : <RefreshCw className="h-8 w-8 animate-spin text-zinc-400" />}
          </div>
          {conn?.pairingCode && (
            <div className="mx-auto max-w-sm rounded-xl bg-zinc-50 p-3 text-sm text-zinc-600">
              Sem câmera? No WhatsApp: <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> → <b>Conectar com número de telefone</b> e digite o código:
              <p className="mt-1.5 font-mono text-2xl font-bold tracking-[.3em] text-zinc-900">{conn.pairingCode}</p>
            </div>
          )}
          <p className="flex items-center justify-center gap-2 text-xs text-zinc-500"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> O QR Code se atualiza sozinho. Esperando a leitura…</p>
          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{err.error}</p>}
          <Button variant="ghost" onClick={onClose}>{reconnect ? 'Fechar (tente de novo depois)' : 'Fechar (a instância fica salva; conecte depois)'}</Button>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"><CheckCircle2 className="h-8 w-8" /></div>
          <div>
            <p className="text-lg font-semibold text-zinc-900">WhatsApp conectado!</p>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-zinc-600"><Smartphone className="h-4 w-4" /> {fmt(conn?.number) || 'Número conectado'}{conn?.profileName ? ` · ${conn.profileName}` : ''}</p>
            <p className="mt-2 text-sm text-zinc-500">A instância <b className="font-mono">{created.current}</b> {reconnect ? 'voltou para o' : 'já está ativa no'} rodízio de envios do checkout.</p>
          </div>
          <Button onClick={onClose}>Concluir</Button>
        </div>
      )}
    </Modal>
  );
}
