import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, EyeOff, MessageCircle, Plus, Radio, Send, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, cn, Field, Input, PageLoader, Select, Switch } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';

interface Instance { name: string; token?: string; active: boolean; token_hint?: string; has_token?: boolean }
interface Config {
  enabled: boolean;
  apiUrl: string;
  instances: Instance[];
  approved: { enabled: boolean };
  recovery: { enabled: boolean; firstMinutes: number; secondMinutes: number; includePix: boolean };
}
type Toast = { ok: (m: string) => void; err: (m: string) => void };

function TokenInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="h-11 pr-10 font-mono text-sm" />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400" aria-label="Mostrar">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
    </div>
  );
}

/** Integrações → WhatsApp (Evolution API): instâncias, mensagens automáticas, teste e prévia. */
export function WhatsAppCard({ toast }: { toast: Toast }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['whatsapp'], queryFn: () => adminApi.get<Config>('/whatsapp') });
  const preview = useQuery({ queryKey: ['whatsapp-preview'], queryFn: () => adminApi.get<{ approved: string; recovery1: string; recovery2: string }>('/whatsapp/preview') });
  const [c, setC] = useState<Config | null>(null);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<'approved' | 'recovery' | 'text'>('approved');
  const [tab, setTab] = useState<'approved' | 'recovery1' | 'recovery2'>('approved');

  useEffect(() => {
    if (data) setC({ ...data, instances: data.instances.map((i) => ({ ...i, token: '' })) });
  }, [data]);

  const save = useMutation({
    mutationFn: (v: Config) => adminApi.put('/whatsapp', v),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['whatsapp'] }), toast.ok('WhatsApp salvo')),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  const check = useMutation({
    mutationFn: () => adminApi.get<{ name: string; online: boolean }[]>('/whatsapp/status'),
    onSuccess: (r) => {
      setStatus(Object.fromEntries(r.map((x) => [x.name, x.online])));
      const on = r.filter((x) => x.online).length;
      (on ? toast.ok : toast.err)(`${on} de ${r.length} instância(s) online`);
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const test = useMutation({
    mutationFn: () => adminApi.post<{ ok: boolean; message: string }>('/whatsapp/test', { phone, kind }),
    onSuccess: (r) => (r.ok ? toast.ok : toast.err)(r.message),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  if (!c) return <section className="rounded-2xl border border-zinc-200 bg-white lg:col-span-2"><PageLoader /></section>;
  const set = (p: Partial<Config>) => setC({ ...c, ...p });
  const setInst = (idx: number, p: Partial<Instance>) => set({ instances: c.instances.map((i, j) => (j === idx ? { ...i, ...p } : i)) });
  const saved = (name: string) => data?.instances.find((i) => i.name === name);

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white lg:col-span-2">
      <header className="flex flex-col gap-3 border-b border-zinc-100 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#25D366] text-white"><MessageCircle className="h-5 w-5" /></div>
          <div>
            <h3 className="font-display font-semibold text-zinc-900">WhatsApp · Evolution API</h3>
            <p className="text-sm text-zinc-500">Envia o acesso quando o pagamento é aprovado e recupera Pix pendentes, com rodízio entre instâncias.</p>
          </div>
        </div>
        <Switch checked={c.enabled} onChange={(v) => set({ enabled: v })} label={c.enabled ? 'Ativado' : 'Desativado'} />
      </header>

      <div className="grid gap-6 p-5 xl:grid-cols-2">
        {/* Conexão */}
        <div className="space-y-4">
          <Field label="URL da Evolution API" hint="Ex.: http://SEU-IP:8082 ou https://evolution.seudominio.com">
            <Input value={c.apiUrl} onChange={(e) => set({ apiUrl: e.target.value })} placeholder="http://0.0.0.0:8082" className="font-mono text-sm" />
          </Field>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-700">Instâncias (nome e token)</p>
              <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}><Radio className="h-3.5 w-3.5" /> Verificar conexão</Button>
            </div>
            <div className="space-y-2">
              {c.instances.map((inst, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2 rounded-xl border border-zinc-200 p-2">
                  <Input value={inst.name} onChange={(e) => setInst(idx, { name: e.target.value })} placeholder="checkout1" className="h-11" />
                  <TokenInput value={inst.token ?? ''} onChange={(v) => setInst(idx, { token: v })} placeholder={saved(inst.name)?.has_token ? `salvo ${saved(inst.name)?.token_hint}` : 'token da instância'} />
                  <div className="flex items-center gap-1">
                    {status[inst.name] !== undefined && (status[inst.name] ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="online" /> : <XCircle className="h-4 w-4 text-red-500" aria-label="offline" />)}
                    <Switch checked={inst.active} onChange={(v) => setInst(idx, { active: v })} />
                    <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => set({ instances: c.instances.filter((_, j) => j !== idx) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
              <Button size="sm" variant="secondary" disabled={c.instances.length >= 20} onClick={() => set({ instances: [...c.instances, { name: `checkout${c.instances.length + 1}`, token: '', active: true }] })}><Plus className="h-4 w-4" /> Adicionar instância</Button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">Tokens ficam protegidos no servidor; deixe em branco para manter o salvo. As mensagens alternam entre as instâncias ativas e pulam as offline.</p>
          </div>

          <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
            <Switch checked={c.approved.enabled} onChange={(v) => set({ approved: { enabled: v } })} label="Enviar acesso quando o pagamento for aprovado" />
            <Switch checked={c.recovery.enabled} onChange={(v) => set({ recovery: { ...c.recovery, enabled: v } })} label="Recuperar Pix pendente (2 lembretes)" />
            {c.recovery.enabled && (
              <div className="grid gap-3 pl-1 sm:grid-cols-2">
                <Field label="1º lembrete após (min)"><Input type="number" min={5} value={c.recovery.firstMinutes} onChange={(e) => set({ recovery: { ...c.recovery, firstMinutes: Number(e.target.value) } })} className="h-11" /></Field>
                <Field label="2º lembrete após (min)"><Input type="number" min={10} value={c.recovery.secondMinutes} onChange={(e) => set({ recovery: { ...c.recovery, secondMinutes: Number(e.target.value) } })} className="h-11" /></Field>
                <div className="sm:col-span-2"><Switch checked={c.recovery.includePix} onChange={(v) => set({ recovery: { ...c.recovery, includePix: v } })} label="Incluir o Pix copia e cola na mensagem" /></div>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button loading={save.isPending} onClick={() => save.mutate(c)}>Salvar WhatsApp</Button>
          </div>
        </div>

        {/* Prévia + teste */}
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex gap-1 rounded-xl bg-zinc-100 p-1 text-xs font-medium">
              {[
                ['approved', 'Pagamento aprovado'],
                ['recovery1', '1º lembrete'],
                ['recovery2', '2º lembrete'],
              ].map(([k, l]) => (
                <button key={k} onClick={() => setTab(k as any)} className={cn('flex-1 rounded-lg px-2 py-1.5 transition', tab === k ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500')}>{l}</button>
              ))}
            </div>
            <div className="rounded-2xl bg-[#e5ddd5] p-4" style={{ backgroundImage: 'radial-gradient(rgba(0,0,0,.04) 1px, transparent 1px)', backgroundSize: '14px 14px' }}>
              <div className="ml-auto max-w-[92%] whitespace-pre-wrap break-words rounded-xl rounded-tr-sm bg-[#dcf8c6] px-3 py-2 text-[13px] leading-relaxed text-[#111b21] shadow-sm">
                {preview.data?.[tab] ?? 'Carregando…'}
              </div>
            </div>
            <p className="mt-2 text-xs text-zinc-500">Exemplo com dados fictícios. Nome do cliente, produto, valor, links e Pix vêm do pedido. As frases variam a cada envio para não parecer robô.</p>
          </div>

          <div className="space-y-2 rounded-xl border border-zinc-200 p-4">
            <p className="text-sm font-medium text-zinc-700">Enviar teste</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="(11) 99999-9999" className="h-11" />
              <Select value={kind} onChange={(e) => setKind(e.target.value as any)} className="h-11 sm:w-48">
                <option value="approved">Pagamento aprovado</option>
                <option value="recovery">Lembrete de Pix</option>
                <option value="text">Texto simples</option>
              </Select>
              <Button className="h-11 shrink-0" loading={test.isPending} disabled={phone.replace(/\D/g, '').length < 10} onClick={() => test.mutate()}><Send className="h-4 w-4" /> Enviar</Button>
            </div>
            <p className="text-xs text-zinc-500">Salve antes de testar. O teste usa as instâncias salvas.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
