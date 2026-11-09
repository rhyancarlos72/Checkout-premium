import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, Mail, PlugZap, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, cn, Field, Input, PageLoader, Switch, useToast } from '@/components/ui';
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
            <p className="text-gray-600">SMTP da Hostinger: <code>SMTP_HOST=smtp.hostinger.com</code>, porta 465. Remetente: {data.email.from ?? '—'}</p>
            <div className="flex gap-2">
              <Input type="email" placeholder="enviar teste para…" value={testTo} onChange={(e) => setTestTo(e.target.value)} className="h-10" />
              <Button size="sm" className="h-10 shrink-0" disabled={!data.email.configured || !testTo} loading={run.isPending && run.variables?.path.includes('email')} onClick={() => run.mutate({ path: '/integrations/email/test', body: { to: testTo } })}><Mail className="h-3.5 w-3.5" /> Testar</Button>
            </div>
            <DeliverabilityCheck />
          </div>
        </Card>

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
      {toast.node}
    </>
  );
}
