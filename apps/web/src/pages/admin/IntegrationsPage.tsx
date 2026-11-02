import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Mail, PlugZap, RefreshCw, XCircle } from 'lucide-react';
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

export default function IntegrationsPage() {
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
      <div className="grid gap-6 lg:grid-cols-2">
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
