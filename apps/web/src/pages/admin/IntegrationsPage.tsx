import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Mail, PlugZap, RefreshCw, Server, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, cn, Field, Input, Modal, PageLoader, Select, Switch, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { GatewayCards } from './GatewayCards';
import { WebhooksCard } from './WebhooksCard';
import { WhatsAppCard } from './WhatsAppCard';
import { InvoicesCard } from './InvoicesCard';
import { useMe } from '@/lib/me';

interface Integrations {
  providers: { name: string; configured: boolean }[];
  paytracking: { configured: boolean; signed: boolean };
  email: { configured: boolean; from: string | null };
  webhooks: { woovi: string; wooviSecretConfigured: boolean; efi: string; efiSecretConfigured: boolean; efiSandbox: boolean };
  jobs: { enabled: boolean };
  lastWebhooks: { provider: string; status: string; error: string | null; reference: string | null; created_at: string }[];
  lastLogs: { integration: string; event: string; ok: boolean; http_status: number | null; message: string; created_at: string }[];
}
interface Settings { recovery: { enabled: boolean; delayMinutes: number }; store: { name: string; supportEmail: string; document: string } }

function Status({ ok, label }: { ok: boolean; label?: string }) {
  return ok ? <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {label ?? 'Configurado'}</span> : <span className="inline-flex items-center gap-1 text-sm font-medium text-gray-500"><XCircle className="h-4 w-4" /> {label ?? 'Não configurado'}</span>;
}

function CopyLine({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <button aria-label="Copiar" onClick={() => navigator.clipboard.writeText(value).then(() => (setOk(true), setTimeout(() => setOk(false), 1500)))} className="text-gray-500 hover:text-gray-900">{ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</button>
    </div>
  );
}

interface DeliverCheck { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string; record?: { type: string; name: string; value: string } }

/** Verificador anti-spam: SPF, DKIM, DMARC, MX e configurações do remetente, com o registro exato para corrigir. */
function DeliverabilityCheck() {
  const q = useMutation({ mutationFn: () => adminApi.get<{ domain: string | null; from: string | null; score: number; checks: DeliverCheck[] }>('/integrations/email/deliverability') });
  const icon = (st: DeliverCheck['status']) => (st === 'ok' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : st === 'warn' ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" /> : <XCircle className="h-4 w-4 shrink-0 text-red-500" />);
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-zinc-700"><b>Anti-spam</b><br /><span className="text-xs text-zinc-500">Confere SPF, DKIM e DMARC exigidos por Gmail, Outlook/Hotmail e Yahoo.</span></p>
        <Button size="sm" variant="secondary" className="shrink-0" loading={q.isPending} onClick={() => q.mutate()}><ShieldCheck className="h-3.5 w-3.5" /> Verificar entrega</Button>
      </div>
      {q.data && (
        <div className="mt-3 space-y-2">
          <p className={cn('text-sm font-semibold', q.data.score >= 9 ? 'text-emerald-700' : q.data.score >= 6 ? 'text-amber-700' : 'text-red-600')}>
            Nota {q.data.score}/10 {q.data.domain ? `· ${q.data.domain}` : ''} {q.data.score >= 9 ? '· pronto para a caixa de entrada' : '· corrija os itens abaixo'}
          </p>
          <ul className="space-y-2">
            {q.data.checks.map((c) => (
              <li key={c.id} className="rounded-lg bg-white px-3 py-2 text-xs ring-1 ring-zinc-200">
                <p className="flex items-center gap-2 font-semibold text-zinc-800">{icon(c.status)} {c.label}</p>
                <p className="mt-0.5 break-words pl-6 text-zinc-500">{c.detail}</p>
                {c.fix && <p className="mt-1 pl-6 text-zinc-700">💡 {c.fix}</p>}
                {c.record && (
                  <div className="ml-6 mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-zinc-50 p-2 font-mono text-[11px] text-zinc-700">
                    <span className="text-zinc-400">Tipo</span><span>{c.record.type}</span>
                    <span className="text-zinc-400">Nome</span><span>{c.record.name}</span>
                    <span className="text-zinc-400">Valor</span><span className="break-all">{c.record.value}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-zinc-500">Depois de alterar o DNS, espere de 15 min a algumas horas e verifique de novo. Para a nota final, envie o teste para o endereço do <a href="https://www.mail-tester.com" target="_blank" rel="noreferrer" className="font-medium text-blue-600 hover:underline">mail-tester.com</a>.</p>
        </div>
      )}
      {q.isError && <p className="mt-2 text-xs text-red-600">{(q.error as Error).message}</p>}
    </div>
  );
}

/** Super Admin vê tudo (gateways, WhatsApp, e-mail); produtor vê só o que é dele (PayTracking/webhooks e nota fiscal). */
export default function IntegrationsPage() {
  const me = useMe();
  if (me.isLoading) return <PageLoader />;
  return me.data?.superAdmin ? <PlatformIntegrations /> : <ProducerIntegrations />;
}

function ProducerIntegrations() {
  const toast = useToast();
  return (
    <>
      <PageHeader title="Integrações" subtitle="Rastreamento (PayTracking / Meta) e nota fiscal do seu negócio. Seus tokens ficam protegidos no servidor e só valem para os seus produtos." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <WebhooksCard toast={toast} />
        <InvoicesCard toast={toast} />
        <Card title="Pagamentos" className="lg:col-span-2">
          <p className="text-sm text-zinc-600">Pix (e cartão, quando liberado) é processado pela plataforma, com o valor da venda dividido automaticamente: a sua parte vai direto para a sua conta de recebimento e a comissão da plataforma para a Prime. A conta de recebimento é configurada pela equipe da plataforma junto com você.</p>
        </Card>
      </div>
      {toast.node}
    </>
  );
}

function PlatformIntegrations() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['integrations'], queryFn: () => adminApi.get<Integrations>('/integrations') });
  const [testTo, setTestTo] = useState('');
  const [smtpOpen, setSmtpOpen] = useState(false);

  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => adminApi.post<{ ok?: boolean; message?: string }>(path, body),
    onSuccess: (r) => { (r.ok === false ? toast.err : toast.ok)(r.message ?? 'Feito'); qc.invalidateQueries({ queryKey: ['integrations'] }); },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  if (isLoading || !data) return <PageLoader />;
  const prov = (n: string) => data.providers.find((p) => p.name === n)?.configured ?? false;

  return (
    <>
      <PageHeader title="Integrações" subtitle="Configure gateways de pagamento e webhooks direto por aqui. Credenciais ficam protegidas no servidor e nunca aparecem completas." />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GatewayCards toast={toast} />

        <WhatsAppCard toast={toast} />

        <InvoicesCard toast={toast} />

        <WebhooksCard toast={toast} />

        <Card title="E-mail (entrega e recuperação)" action={<Status ok={data.email.configured} />}>
          <div className="space-y-3 text-sm">
            <SmtpSummary onEdit={() => setSmtpOpen(true)} />
            <div className="flex gap-2">
              <Input type="email" placeholder="enviar teste para…" value={testTo} onChange={(e) => setTestTo(e.target.value)} className="h-10" />
              <Button size="sm" className="h-10 shrink-0" disabled={!data.email.configured || !testTo} loading={run.isPending && run.variables?.path.includes('email')} onClick={() => run.mutate({ path: '/integrations/email/test', body: { to: testTo } })}><Mail className="h-3.5 w-3.5" /> Testar</Button>
            </div>
            <DeliverabilityCheck />
          </div>
        </Card>
        {smtpOpen && <SmtpModal onClose={() => setSmtpOpen(false)} onSaved={(m) => { toast.ok(m); qc.invalidateQueries({ queryKey: ['integrations'] }); }} />}

        <Card title="Conciliação de pagamentos" className="lg:col-span-2">
          <div className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-zinc-600">A cada 2 minutos o sistema confere Pix pendentes direto no gateway, envia a recuperação e atualiza as notas fiscais. Dados da loja, meta e recuperação ficam em <Link to="/admin/configuracoes?tab=loja" className="font-medium text-blue-600 hover:underline">Configurações</Link>.</p>
            <Button variant="secondary" className="shrink-0" loading={run.isPending && run.variables?.path === '/jobs/run'} onClick={() => run.mutate({ path: '/jobs/run' })}><RefreshCw className="h-4 w-4" /> Rodar agora</Button>
          </div>
        </Card>

        <Card title="Últimos webhooks recebidos">
          {data.lastWebhooks.length === 0 ? <p className="text-sm text-gray-500">Nenhum webhook ainda.</p> : (
            <ul className="space-y-2 text-sm">
              {data.lastWebhooks.map((w, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', w.status === 'processed' ? 'bg-emerald-500' : w.status === 'error' ? 'bg-red-500' : 'bg-gray-400')} />
                  <span className="font-medium">{w.provider}</span><span className="flex-1 truncate text-gray-500">{w.error ?? w.status}</span><span className="shrink-0 text-xs text-gray-400">{dateTime(w.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Últimos envios (PayTracking / e-mail)">
          {data.lastLogs.length === 0 ? <p className="text-sm text-gray-500">Nenhum envio ainda.</p> : (
            <ul className="space-y-2 text-sm">
              {data.lastLogs.map((l, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', l.ok ? 'bg-emerald-500' : 'bg-red-500')} />
                  <span className="font-medium">{l.integration}</span><span className="text-gray-500">{l.event}</span><span className="flex-1 truncate text-gray-500">{l.message}</span><span className="shrink-0 text-xs text-gray-400">{dateTime(l.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-6 text-xs text-gray-400">Cidade e estado do visitante (Pixel e PayTracking): <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">IP Geolocation by DB-IP</a>, consultado no próprio servidor.</p>
      {toast.node}
    </>
  );
}

// ---------------------------------------------------------------- SMTP (servidor de e-mail)
interface SmtpInfo { source: 'painel' | 'env' | null; host: string | null; port: number | null; secure: boolean; user: string | null; from: string | null; fromName: string | null; hasPassword: boolean; pass_hint: string | null }
const smtpKey = ['integrations', 'smtp'];

function SmtpSummary({ onEdit }: { onEdit: () => void }) {
  const { data } = useQuery({ queryKey: smtpKey, queryFn: () => adminApi.get<SmtpInfo>('/integrations/email/smtp') });
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-gray-600">
        {data?.host ? (
          <>
            <p className="truncate"><span className="font-medium text-gray-800">{data.host}</span>:{data.port} · {data.secure ? 'SSL' : 'STARTTLS'}</p>
            <p className="truncate text-xs">Remetente: {data.fromName ? `${data.fromName} <${data.from ?? data.user}>` : (data.from ?? data.user ?? '—')} · {data.source === 'painel' ? 'configurado pelo painel' : 'pelas variáveis de ambiente'}</p>
          </>
        ) : (
          <p>Nenhum servidor de e-mail configurado.</p>
        )}
      </div>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={onEdit}><Server className="h-3.5 w-3.5" /> {data?.host ? 'Alterar SMTP' : 'Configurar SMTP'}</Button>
    </div>
  );
}

const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  hostinger: { host: 'smtp.hostinger.com', port: 465, secure: true },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
  zoho: { host: 'smtp.zoho.com', port: 465, secure: true },
};

function SmtpModal({ onClose, onSaved }: { onClose: () => void; onSaved: (msg: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: smtpKey, queryFn: () => adminApi.get<SmtpInfo>('/integrations/email/smtp') });
  const [f, setF] = useState<{ host: string; port: string; secure: boolean; user: string; pass: string; from: string; fromName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = f ?? { host: data?.host ?? '', port: String(data?.port ?? 465), secure: data?.secure ?? true, user: data?.user ?? '', pass: '', from: data?.from ?? '', fromName: data?.fromName ?? '' };
  const set = (patch: Partial<typeof v>) => setF({ ...v, ...patch });
  const done = (msg: string) => { qc.invalidateQueries({ queryKey: smtpKey }); onSaved(msg); onClose(); };
  const save = useMutation({
    mutationFn: () => adminApi.put<{ message: string }>('/integrations/email/smtp', { host: v.host, port: Number(v.port), secure: v.secure, user: v.user, pass: v.pass || undefined, from: v.from, fromName: v.fromName }),
    onSuccess: (r) => done(r.message),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  const reset = useMutation({ mutationFn: () => adminApi.del('/integrations/email/smtp'), onSuccess: () => done('Voltou a usar as variáveis SMTP_* do servidor'), onError: (e) => setError(e instanceof ApiError ? e.message : 'Erro') });
  const keepsPass = data?.source === 'painel' && data.hasPassword;

  return (
    <Modal open onClose={onClose} title="Servidor de e-mail (SMTP)">
      {isLoading ? <PageLoader /> : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}>
          <p className="text-sm text-gray-600">Usado para enviar o acesso ao produto, os códigos da área de membros e a recuperação de vendas. Antes de salvar, o sistema testa a conexão com o servidor.</p>
          <Field label="Provedor (atalho)">
            <Select value="" onChange={(e) => { const p = SMTP_PRESETS[e.target.value]; if (p) set({ host: p.host, port: String(p.port), secure: p.secure }); }}>
              <option value="">Preencher automaticamente…</option>
              <option value="hostinger">Hostinger</option>
              <option value="gmail">Gmail / Google Workspace</option>
              <option value="outlook">Outlook / Microsoft 365</option>
              <option value="zoho">Zoho Mail</option>
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Servidor" className="col-span-2"><Input value={v.host} onChange={(e) => set({ host: e.target.value })} placeholder="smtp.hostinger.com" required /></Field>
            <Field label="Porta"><Input value={v.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} inputMode="numeric" required /></Field>
          </div>
          <Field label="Segurança">
            <Select value={v.secure ? 'ssl' : 'tls'} onChange={(e) => set({ secure: e.target.value === 'ssl', port: e.target.value === 'ssl' ? '465' : '587' })}>
              <option value="ssl">SSL (porta 465)</option>
              <option value="tls">STARTTLS (porta 587)</option>
            </Select>
          </Field>
          <Field label="Usuário (e-mail da conta)"><Input value={v.user} onChange={(e) => set({ user: e.target.value })} type="email" autoComplete="off" placeholder="contato@seudominio.com" required /></Field>
          <Field label="Senha" hint={keepsPass ? `Deixe em branco para manter a senha salva (${data?.pass_hint ?? '••••'})` : 'Senha do e-mail (no Gmail, use uma senha de app)'}>
            <Input value={v.pass} onChange={(e) => set({ pass: e.target.value })} type="password" autoComplete="new-password" required={!keepsPass} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="E-mail remetente" hint="Vazio = o usuário acima"><Input value={v.from} onChange={(e) => set({ from: e.target.value })} type="email" placeholder="contato@seudominio.com" /></Field>
            <Field label="Nome do remetente"><Input value={v.fromName} onChange={(e) => set({ fromName: e.target.value })} placeholder="Sua Loja" maxLength={80} /></Field>
          </div>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            {data?.source === 'painel' ? <Button type="button" variant="ghost" size="sm" loading={reset.isPending} onClick={() => reset.mutate()}>Usar variáveis do servidor</Button> : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
              <Button type="submit" loading={save.isPending}>Testar e salvar</Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
