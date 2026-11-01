import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, MessageCircle, Plus, Radio, Search, Send, Stethoscope, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, cn, Field, Input, PageLoader, Select, Switch } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';

interface Instance { name: string; token?: string; active: boolean; token_hint?: string; has_token?: boolean }
interface Config {
  enabled: boolean;
  apiUrl: string;
  globalApiKey: string;
  globalApiKey_hint?: string;
  has_globalApiKey?: boolean;
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
  const [status, setStatus] = useState<Record<string, { ok: boolean; message: string; hint?: string }>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; hint?: string } | null>(null);
  const [diag, setDiag] = useState<{ steps: { label: string; ok: boolean | null; detail: string; hint?: string }[] } | null>(null);
  const logs = useQuery({ queryKey: ['whatsapp-logs'], queryFn: () => adminApi.get<{ event: string; ok: boolean; message: string; created_at: string }[]>('/whatsapp/logs'), refetchInterval: 30_000 });
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<'approved' | 'recovery' | 'text'>('approved');
  const [tab, setTab] = useState<'approved' | 'recovery1' | 'recovery2'>('approved');
  const [found, setFound] = useState<{ name: string; status: string | null; connected: boolean; number: string | null; profileName: string | null; hasToken: boolean }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [discoverErr, setDiscoverErr] = useState<{ error: string; hint?: string } | null>(null);
  const discover = useMutation({
    mutationFn: () => adminApi.post<any>('/whatsapp/discover', { apiUrl: c?.apiUrl, apiKey: c?.globalApiKey || undefined }),
    onSuccess: (r) => {
      if (!r.ok) return (setFound(null), setDiscoverErr(r));
      setDiscoverErr(null);
      setFound(r.items);
      setPicked(r.items.filter((i: any) => i.connected).map((i: any) => i.name));
    },
    onError: (e) => setDiscoverErr({ error: e instanceof ApiError ? e.message : 'Erro' }),
  });
  const importIt = useMutation({
    mutationFn: () => adminApi.post<{ count: number }>('/whatsapp/import', { apiUrl: c?.apiUrl, apiKey: c?.globalApiKey || undefined, names: picked, replace: true }),
    onSuccess: (r) => {
      toast.ok(`${r.count} instância(s) importada(s) com o nome exato da Evolution`);
      setFound(null);
      setStatus({});
      qc.invalidateQueries({ queryKey: ['whatsapp'] });
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const fmtPhone = (n: string | null) => (n && n.length >= 12 ? `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, -4)}-${n.slice(-4)}` : n ?? 'sem número');

  useEffect(() => {
    if (data) setC({ ...data, globalApiKey: '', instances: data.instances.map((i) => ({ ...i, token: '' })) });
  }, [data]);

  const save = useMutation({
    mutationFn: (v: Config) => adminApi.put('/whatsapp', v),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['whatsapp'] }), toast.ok('WhatsApp salvo')),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  const check = useMutation({
    mutationFn: () => adminApi.get<{ name: string; ok: boolean; message: string; hint?: string }[]>('/whatsapp/status'),
    onSuccess: (r) => {
      setStatus(Object.fromEntries(r.map((x) => [x.name, x])));
      const on = r.filter((x) => x.ok).length;
      (on ? toast.ok : toast.err)(`${on} de ${r.length} instância(s) prontas`);
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const test = useMutation({
    mutationFn: () => adminApi.post<{ ok: boolean; message: string; hint?: string }>('/whatsapp/test', { phone, kind }),
    onSuccess: (r) => (setTestResult(r), qc.invalidateQueries({ queryKey: ['whatsapp-logs'] })),
    onError: (e) => setTestResult({ ok: false, message: e instanceof ApiError ? e.message : 'Erro' }),
  });
  const diagnose = useMutation({
    mutationFn: () => adminApi.get<{ steps: { label: string; ok: boolean | null; detail: string; hint?: string }[]; instances: { name: string; ok: boolean; message: string; hint?: string }[] }>('/whatsapp/diagnose'),
    onSuccess: (r) => (setDiag(r), setStatus(Object.fromEntries(r.instances.map((x) => [x.name, x])))),
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

      {!c.enabled && (
        <div className="mx-5 mt-5 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>O envio automático está <b>desativado</b>. Ligue o botão “Ativado” acima e clique em <b>Salvar WhatsApp</b>. (O envio de teste funciona mesmo desativado.)</span>
        </div>
      )}

      {/* Diagnóstico */}
      <div className="mx-5 mt-5 rounded-xl border border-zinc-200 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-zinc-800"><Stethoscope className="h-4 w-4 text-blue-600" /> Diagnóstico</p>
            <p className="text-xs text-zinc-500">Confere a configuração, a conexão com a Evolution e cada instância, e diz o que corrigir. Salve antes de diagnosticar.</p>
          </div>
          <Button size="sm" variant="secondary" loading={diagnose.isPending} onClick={() => diagnose.mutate()}>Diagnosticar agora</Button>
        </div>
        {diag && (
          <ul className="mt-3 space-y-2">
            {diag.steps.map((st, i) => (
              <li key={i} className={cn('rounded-lg px-3 py-2 text-sm', st.ok === false ? 'bg-red-50' : st.ok === null ? 'bg-amber-50' : 'bg-emerald-50')}>
                <p className="flex items-center gap-2 font-medium text-zinc-800">
                  {st.ok === false ? <XCircle className="h-4 w-4 shrink-0 text-red-600" /> : st.ok === null ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
                  {st.label}: <span className="font-normal text-zinc-700">{st.detail}</span>
                </p>
                {st.hint && <p className="mt-1 pl-6 text-xs text-zinc-600">💡 {st.hint}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-6 p-5 xl:grid-cols-2">
        {/* Conexão */}
        <div className="space-y-4">
          <Field label="URL da Evolution API" hint="Ex.: http://SEU-IP:8082 ou https://evolution.seudominio.com">
            <Input value={c.apiUrl} onChange={(e) => set({ apiUrl: e.target.value })} placeholder="http://0.0.0.0:8082" className="font-mono text-sm" />
          </Field>

          <Field label="API Key global da Evolution (opcional, recomendado)" hint={c.has_globalApiKey ? `Salva: ${c.globalApiKey_hint} · deixe em branco para manter` : 'Variável AUTHENTICATION_API_KEY da Evolution. Vale para todas as instâncias e permite buscar a lista abaixo.'}>
            <TokenInput value={c.globalApiKey} onChange={(v) => set({ globalApiKey: v })} placeholder={c.has_globalApiKey ? '••••••••' : 'API Key global'} />
          </Field>

          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-zinc-700"><b>Buscar instâncias da Evolution</b><br /><span className="text-xs text-zinc-500">Puxa nome exato, status e número de cada instância — sem digitar.</span></p>
              <Button size="sm" className="shrink-0 whitespace-nowrap" loading={discover.isPending} disabled={!c.apiUrl} onClick={() => discover.mutate()}><Search className="h-3.5 w-3.5" /> Buscar instâncias</Button>
            </div>
            {discoverErr && (
              <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {discoverErr.error}
                {discoverErr.hint && <p className="mt-1 text-xs text-zinc-600">💡 {discoverErr.hint}</p>}
              </div>
            )}
            {found && (
              <div className="mt-3 space-y-2">
                {found.length === 0 ? (
                  <p className="text-sm text-zinc-500">Nenhuma instância encontrada nesta Evolution.</p>
                ) : (
                  found.map((f) => {
                    const on = picked.includes(f.name);
                    return (
                      <button key={f.name} type="button" onClick={() => setPicked(on ? picked.filter((x) => x !== f.name) : [...picked, f.name])} className={cn('flex w-full items-center gap-3 rounded-lg border bg-white px-3 py-2.5 text-left text-sm transition', on ? 'border-blue-500' : 'border-zinc-200')}>
                        <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300')}>{on && '✓'}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono font-semibold text-zinc-900">{f.name}</span>
                          <span className="block truncate text-xs text-zinc-500">{fmtPhone(f.number)}{f.profileName ? ` · ${f.profileName}` : ''}</span>
                        </span>
                        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', f.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>{f.connected ? 'conectada' : f.status ?? 'desconectada'}</span>
                      </button>
                    );
                  })
                )}
                {found.length > 0 && (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <p className="text-xs text-zinc-500">As selecionadas substituem a lista atual. Desconectadas precisam do QR Code na Evolution.</p>
                    <Button size="sm" className="shrink-0 whitespace-nowrap" loading={importIt.isPending} disabled={!picked.length} onClick={() => importIt.mutate()}>Importar {picked.length || ''}</Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium text-zinc-700">Instâncias (nome e token)</p>
              <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}><Radio className="h-3.5 w-3.5" /> Verificar conexão</Button>
            </div>
            <div className="space-y-2">
              {c.instances.map((inst, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2 rounded-xl border border-zinc-200 p-2">
                  <Input value={inst.name} onChange={(e) => setInst(idx, { name: e.target.value })} placeholder="checkout1" className="h-11" />
                  <TokenInput value={inst.token ?? ''} onChange={(v) => setInst(idx, { token: v })} placeholder={saved(inst.name)?.has_token ? `salvo ${saved(inst.name)?.token_hint}` : c.has_globalApiKey || c.globalApiKey ? 'usa a API Key global' : 'token da instância'} />
                  <div className="flex items-center gap-1">
                    {status[inst.name] !== undefined && (status[inst.name].ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="pronta" /> : <XCircle className="h-4 w-4 text-red-500" aria-label="com problema" />)}
                    <Switch checked={inst.active} onChange={(v) => setInst(idx, { active: v })} />
                    <Button size="sm" variant="ghost" aria-label="Remover" onClick={() => set({ instances: c.instances.filter((_, j) => j !== idx) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  {status[inst.name] && (
                    <div className={cn('col-span-3 rounded-lg px-2.5 py-1.5 text-xs', status[inst.name].ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
                      {status[inst.name].message}
                      {status[inst.name].hint && <span className="mt-0.5 block text-zinc-600">💡 {status[inst.name].hint}</span>}
                    </div>
                  )}
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
            {testResult && (
              <div className={cn('rounded-lg px-3 py-2 text-sm', testResult.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800')}>
                <p className="flex items-start gap-2 font-medium">{testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}<span className="break-words">{testResult.message}</span></p>
                {testResult.hint && <p className="mt-1 pl-6 text-xs text-zinc-700">💡 {testResult.hint}</p>}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-200 p-4">
            <p className="mb-2 text-sm font-medium text-zinc-700">Últimos envios</p>
            {!logs.data?.length ? (
              <p className="text-xs text-zinc-500">Nenhum envio ainda.</p>
            ) : (
              <ul className="space-y-1.5">
                {logs.data.map((l, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    {l.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
                    <span className="shrink-0 font-medium text-zinc-700">{({ approved: 'Aprovado', recovery_1: '1º lembrete', recovery_2: '2º lembrete', test_approved: 'Teste', test_recovery: 'Teste', test_text: 'Teste' } as Record<string, string>)[l.event] ?? l.event}</span>
                    <span className={cn('min-w-0 flex-1 break-words', l.ok ? 'text-zinc-500' : 'text-red-600')}>{l.message}</span>
                    <span className="shrink-0 text-zinc-400">{new Date(l.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
