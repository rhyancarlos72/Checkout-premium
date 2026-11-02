import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Eye, EyeOff, FileKey2, PlugZap, RefreshCw, Settings2, Trash2, Upload, XCircle } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Button, cn, Field, Input, Modal, PageLoader } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { PixIcon } from '../checkout/CheckoutView';

interface Gateways {
  defaultProvider: 'woovi' | 'efi' | null;
  woovi: { configured: boolean; source: 'painel' | 'env' | null; appId_hint: string; hasWebhookSecret: boolean; webhookUrl: string };
  efi: {
    configured: boolean;
    clientId_hint: string;
    hasClientSecret: boolean;
    pixKey: string;
    sandbox: boolean;
    cert: { source: 'painel' | 'env' | null; name: string; uploadedAt: string | null } | null;
    hasWebhookSecret: boolean;
    webhookUrl: string;
  };
}
type Toast = { ok: (m: string) => void; err: (m: string) => void };

const EfiLogo = () => (
  <span className="flex items-baseline gap-1 font-display leading-none">
    <span className="text-[28px] font-extrabold tracking-tight text-[#f37021]">efí</span>
    <span className="text-[10px] font-bold tracking-[.2em] text-[#f37021]">BANK</span>
  </span>
);
const WooviLogo = () => (
  <span className="flex items-center gap-1.5 font-display leading-none">
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#03d69d] text-sm font-black text-white">w</span>
    <span className="text-[22px] font-extrabold tracking-tight text-[#03d69d]">woovi</span>
  </span>
);

function Status({ ok, text }: { ok: boolean; text?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600"><CheckCircle2 className="h-4 w-4" /> {text ?? 'Conectado'}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500"><XCircle className="h-4 w-4" /> {text ?? 'Não configurado'}</span>
  );
}

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="pr-11 font-mono text-sm" />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700" aria-label={show ? 'Ocultar' : 'Mostrar'}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function CopyBox({ value, toast }: { value: string; toast: Toast }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5">
      <code className="min-w-0 flex-1 truncate text-xs text-zinc-700">{value}</code>
      <button onClick={() => navigator.clipboard.writeText(value).then(() => toast.ok('Copiado'))} className="text-zinc-500 hover:text-zinc-900" aria-label="Copiar"><Copy className="h-4 w-4" /></button>
    </div>
  );
}

function GatewayCard({ logo, title, desc, status, detail, onConfigure, onTest, testing }: { logo: ReactNode; title: string; desc: string; status: ReactNode; detail: ReactNode; onConfigure: () => void; onTest: () => void; testing: boolean }) {
  return (
    <section className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="flex items-start justify-between gap-3">
        <div>{logo}<p className="mt-3 font-display text-lg font-semibold text-zinc-900">{title}</p><p className="text-sm text-zinc-500">{desc}</p></div>
        {status}
      </div>
      <div className="mt-4 flex-1 space-y-1.5 text-sm text-zinc-600">{detail}</div>
      <div className="mt-5 flex gap-2">
        <Button onClick={onConfigure}><Settings2 className="h-4 w-4" /> Configurar</Button>
        <Button variant="secondary" loading={testing} onClick={onTest}><PlugZap className="h-4 w-4" /> Testar conexão</Button>
      </div>
    </section>
  );
}

/** Um gateway para todos os produtos de uma vez (sem precisar escolher em cada checkout). */
function DefaultGatewayCard({ current, configured, toast, onSaved }: { current: 'woovi' | 'efi' | null; configured: { efi: boolean; woovi: boolean }; toast: Toast; onSaved: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (provider: 'woovi' | 'efi' | null) => adminApi.put<{ ok: boolean; message: string }>('/gateways/default', { provider }),
    onSuccess: (r) => {
      toast.ok(r.message);
      onSaved();
      qc.invalidateQueries({ queryKey: ['checkouts'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast.err(err instanceof ApiError ? err.message : 'Erro ao salvar'),
  });
  const options: { value: 'woovi' | 'efi' | null; label: ReactNode; hint: string; disabled?: boolean }[] = [
    { value: 'efi', label: <EfiLogo />, hint: configured.efi ? 'Todos os produtos recebem pela Efí' : 'Configure a Efí abaixo para usar', disabled: !configured.efi },
    { value: 'woovi', label: <WooviLogo />, hint: configured.woovi ? 'Todos os produtos recebem pela Woovi' : 'Configure a Woovi abaixo para usar', disabled: !configured.woovi },
    { value: null, label: <span className="font-display text-base font-bold text-zinc-800">Por checkout</span>, hint: 'Cada checkout usa o gateway escolhido nele' },
  ];
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 lg:col-span-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-900"><PixIcon className="h-5 w-5" /> Gateway para todos os produtos</h3>
          <p className="text-sm text-zinc-500">Escolha uma vez e vale para todos os produtos e checkouts, inclusive os criados depois.</p>
        </div>
        {save.isPending && <RefreshCw className="h-4 w-4 animate-spin text-zinc-400" />}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {options.map((o) => {
          const active = current === o.value;
          return (
            <button
              key={String(o.value)}
              type="button"
              disabled={o.disabled || save.isPending}
              onClick={() => !active && save.mutate(o.value)}
              className={cn(
                'relative flex min-h-[92px] flex-col items-start justify-between gap-2 rounded-xl border-2 p-4 text-left transition',
                active ? 'border-blue-600 bg-blue-50/60 ring-4 ring-blue-600/10' : 'border-zinc-200 hover:border-zinc-300',
                o.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {active && <CheckCircle2 className="absolute right-3 top-3 h-5 w-5 text-blue-600" />}
              {o.label}
              <span className="text-xs text-zinc-500">{o.hint}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function GatewayCards({ toast }: { toast: Toast }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['gateways'], queryFn: () => adminApi.get<Gateways>('/gateways') });
  const [open, setOpen] = useState<'efi' | 'woovi' | null>(null);
  const refresh = () => (qc.invalidateQueries({ queryKey: ['gateways'] }), qc.invalidateQueries({ queryKey: ['integrations'] }));
  const test = useMutation({
    mutationFn: (name: 'efi' | 'woovi') => adminApi.post<{ ok: boolean; message: string }>(`/gateways/${name}/test`),
    onSuccess: (r) => (r.ok ? toast.ok : toast.err)(r.message),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  if (isLoading || !data) return <div className="lg:col-span-2"><PageLoader /></div>;
  const e = data.efi;
  const w = data.woovi;
  return (
    <>
      <DefaultGatewayCard current={data.defaultProvider} configured={{ efi: e.configured, woovi: w.configured }} toast={toast} onSaved={refresh} />
      <GatewayCard
        logo={<EfiLogo />}
        title={`Efí Bank${e.sandbox ? ' · homologação' : ''}`}
        desc="Pix com QR Code e Copia e Cola via API Pix da Efí."
        status={<Status ok={e.configured} />}
        detail={
          <>
            <p>Client ID: <span className="font-mono">{e.clientId_hint || '—'}</span></p>
            <p className="truncate">Chave Pix: <span className="font-mono">{e.pixKey || '—'}</span></p>
            <p className="flex items-center gap-1.5"><FileKey2 className="h-4 w-4 text-zinc-400" /> {e.cert ? <>Certificado: <b className="font-medium text-zinc-800">{e.cert.name}</b>{e.cert.source === 'env' && ' (variável)'}</> : <span className="text-amber-600">Certificado .p12 não enviado</span>}</p>
          </>
        }
        onConfigure={() => setOpen('efi')}
        onTest={() => test.mutate('efi')}
        testing={test.isPending && test.variables === 'efi'}
      />
      <GatewayCard
        logo={<WooviLogo />}
        title="Woovi (OpenPix)"
        desc="Pix com QR Code e Copia e Cola via Woovi."
        status={<Status ok={w.configured} />}
        detail={
          <>
            <p>AppID: <span className="font-mono">{w.appId_hint || '—'}</span>{w.source === 'env' && ' (variável)'}</p>
            <p>Webhook protegido: {w.hasWebhookSecret ? <span className="text-emerald-600">sim</span> : <span className="text-amber-600">não (recomendado)</span>}</p>
          </>
        }
        onConfigure={() => setOpen('woovi')}
        onTest={() => test.mutate('woovi')}
        testing={test.isPending && test.variables === 'woovi'}
      />
      {open === 'efi' && <EfiModal data={e} toast={toast} onClose={() => setOpen(null)} onSaved={refresh} />}
      {open === 'woovi' && <WooviModal data={w} toast={toast} onClose={() => setOpen(null)} onSaved={refresh} />}
    </>
  );
}

// ------------------------------------------------------------------ Efí
function EfiModal({ data, toast, onClose, onSaved }: { data: Gateways['efi']; toast: Toast; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ clientId: '', clientSecret: '', pixKey: data.pixKey, sandbox: data.sandbox });
  const [file, setFile] = useState<File | null>(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setError(null);
    if (!data.clientId_hint && !f.clientId) return setError('Informe o Client ID');
    if (!data.hasClientSecret && !f.clientSecret) return setError('Informe o Client Secret');
    if (!f.pixKey.trim()) return setError('Informe a chave Pix cadastrada na Efí');
    setBusy('save');
    try {
      if (file) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        await adminApi.post('/gateways/efi/certificate', { fileName: file.name, fileBase64: btoa(bin), passphrase: pass });
      } else if (!data.cert) {
        setBusy(null);
        return setError('Envie o certificado .p12 da sua aplicação Efí');
      }
      await adminApi.put('/gateways/efi', { clientId: f.clientId || undefined, clientSecret: f.clientSecret || undefined, pixKey: f.pixKey.trim(), sandbox: f.sandbox });
      onSaved();
      const t = await adminApi.post<{ ok: boolean; message: string }>('/gateways/efi/test');
      (t.ok ? toast.ok : toast.err)(t.ok ? `Salvo! ${t.message}` : `Salvo, mas o teste falhou: ${t.message}`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(null);
    }
  }

  async function registerWebhook() {
    setBusy('hook');
    try {
      const r = await adminApi.post<{ message: string }>('/integrations/efi/register-webhook');
      toast.ok(r.message);
      onSaved();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : 'Erro');
    } finally {
      setBusy(null);
    }
  }

  async function removeCert() {
    if (!confirm('Remover o certificado salvo? A Efí deixa de funcionar até enviar outro.')) return;
    await adminApi.del('/gateways/efi/certificate');
    onSaved();
    toast.ok('Certificado removido');
  }

  return (
    <Modal open onClose={onClose} title="Efí Bank" wide>
      <div className="space-y-5">
        <div className="flex items-center gap-4 border-b border-zinc-100 pb-4">
          <EfiLogo />
          <p className="text-sm text-zinc-500">Configure sua integração Efí Bank para pagamentos Pix. Os dados ficam protegidos no servidor e nunca aparecem completos aqui.</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Client ID" hint={data.clientId_hint ? `Salvo: ${data.clientId_hint} · deixe em branco para manter` : 'O Client ID da sua aplicação na Efí'}>
            <SecretInput value={f.clientId} onChange={(v) => setF({ ...f, clientId: v })} placeholder={data.clientId_hint ? '••••••••••••' : 'Client_Id_...'} />
          </Field>
          <Field label="Client Secret" hint={data.hasClientSecret ? 'Salvo · deixe em branco para manter' : 'O Client Secret da sua aplicação na Efí'}>
            <SecretInput value={f.clientSecret} onChange={(v) => setF({ ...f, clientSecret: v })} placeholder={data.hasClientSecret ? '••••••••••••' : 'Client_Secret_...'} />
          </Field>
        </div>
        <Field label="Chave Pix" hint="Chave Pix cadastrada na Efí (aleatória, e-mail, CPF/CNPJ ou telefone)">
          <Input value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} placeholder="9ccb5382-b61b-4269-aec8-6bd7ce135124" className="font-mono text-sm" />
        </Field>

        {/* Certificado */}
        <div>
          <p className="mb-2 text-sm font-medium text-zinc-700">Certificado (.p12)</p>
          {data.cert && !file ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <FileKey2 className="h-6 w-6 shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-emerald-800">{data.cert.name}</p>
                <p className="text-xs text-emerald-700">{data.cert.source === 'env' ? 'Vindo das variáveis de ambiente' : data.cert.uploadedAt ? `Enviado em ${dateTime(data.cert.uploadedAt)} · validado` : 'Validado'}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><RefreshCw className="h-3.5 w-3.5" /> Trocar</Button>
              {data.cert.source === 'painel' && <Button size="sm" variant="ghost" aria-label="Remover" onClick={removeCert}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault();
                const fl = ev.dataTransfer.files?.[0];
                if (fl) setFile(fl);
              }}
              className={cn('flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition', file ? 'border-blue-500 bg-blue-50/50' : 'border-zinc-300 hover:border-blue-500')}
            >
              <Upload className="h-6 w-6 text-zinc-400" />
              {file ? <p className="text-sm font-semibold text-zinc-800">{file.name} <span className="font-normal text-zinc-500">({Math.ceil(file.size / 1024)} KB) · será validado ao salvar</span></p> : <p className="text-sm text-zinc-600"><b>Clique para enviar</b> ou arraste o arquivo <code>.p12</code> baixado na Efí (API → Aplicações → Certificados)</p>}
            </button>
          )}
          <input ref={fileRef} type="file" accept=".p12,.pfx,application/x-pkcs12" hidden onChange={(ev) => ev.target.files?.[0] && setFile(ev.target.files[0])} />
          {file && (
            <div className="mt-3">
              <Field label="Senha do certificado (se tiver)" hint="Os certificados da Efí normalmente não têm senha: deixe em branco.">
                <SecretInput value={pass} onChange={setPass} />
              </Field>
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-zinc-700">Ambiente</p>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-zinc-100 p-1">
            {[
              { v: false, t: 'Produção' },
              { v: true, t: 'Homologação (testes)' },
            ].map((o) => (
              <button key={String(o.v)} type="button" onClick={() => setF({ ...f, sandbox: o.v })} className={cn('rounded-lg py-2 text-sm font-medium transition', f.sandbox === o.v ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500')}>{o.t}</button>
            ))}
          </div>
        </div>

        {data.configured && (
          <div className="space-y-2 rounded-xl border border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-800">Webhook de confirmação</p>
            <p className="text-xs text-zinc-500">Registre uma vez (e de novo se trocar a chave Pix ou o certificado). A URL inclui um segredo para recusar notificações falsas.</p>
            <CopyBox value={`${data.webhookUrl}?hmac=•••`} toast={toast} />
            <Button size="sm" variant="secondary" loading={busy === 'hook'} onClick={registerWebhook}>Registrar webhook na Efí</Button>
          </div>
        )}

        {error && <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button loading={busy === 'save'} onClick={save}>Salvar e testar</Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Woovi
function WooviModal({ data, toast, onClose, onSaved }: { data: Gateways['woovi']; toast: Toast; onClose: () => void; onSaved: () => void }) {
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!data.appId_hint && !appId.trim()) return setError('Cole o AppID da sua conta Woovi');
    setBusy('save');
    try {
      if (appId.trim()) await adminApi.put('/gateways/woovi', { appId: appId.trim() });
      onSaved();
      const t = await adminApi.post<{ ok: boolean; message: string }>('/gateways/woovi/test');
      (t.ok ? toast.ok : toast.err)(t.ok ? `Salvo! ${t.message}` : `Salvo, mas o teste falhou: ${t.message}`);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(null);
    }
  }
  async function revealSecret(regenerate = false) {
    setBusy('secret');
    try {
      if (regenerate) await adminApi.put('/gateways/woovi', { regenerateSecret: true });
      const r = await adminApi.get<{ secret: string }>('/gateways/woovi/webhook-secret');
      setSecret(r.secret);
      onSaved();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : 'Erro');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Woovi (OpenPix)" wide>
      <div className="space-y-5">
        <div className="flex items-center gap-4 border-b border-zinc-100 pb-4">
          <WooviLogo />
          <p className="text-sm text-zinc-500">Cole o AppID da sua conta Woovi (API/Plugins → Nova API). Ele fica protegido no servidor.</p>
        </div>
        <Field label="AppID" hint={data.appId_hint ? `Salvo: ${data.appId_hint} · deixe em branco para manter` : 'Chave de API da Woovi'}>
          <SecretInput value={appId} onChange={setAppId} placeholder={data.appId_hint ? '••••••••••••' : 'Q2xpZW50X0lk...'} />
        </Field>

        <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-800"><PixIcon className="h-4 w-4" /> Webhook de pagamento</p>
          <p className="text-xs text-zinc-500">No painel da Woovi → Webhooks, crie um com o evento <b>OPENPIX:CHARGE_COMPLETED</b> e esta URL:</p>
          <CopyBox value={data.webhookUrl} toast={toast} />
          <p className="text-xs text-zinc-500">
            Recomendado: proteja o webhook. Gere o segredo abaixo e cole no campo <b>Authorization</b> do webhook na Woovi. A partir daí, notificações sem esse valor são recusadas (os pagamentos continuam sendo conferidos a cada 2 min).
          </p>
          {secret ? (
            <>
              <CopyBox value={secret} toast={toast} />
              <Button size="sm" variant="ghost" loading={busy === 'secret'} onClick={() => confirm('Gerar um novo segredo? Você vai precisar atualizar o valor na Woovi.') && revealSecret(true)}><RefreshCw className="h-3.5 w-3.5" /> Gerar novo segredo</Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" loading={busy === 'secret'} onClick={() => revealSecret(false)}>{data.hasWebhookSecret ? 'Mostrar segredo do webhook' : 'Gerar segredo do webhook'}</Button>
          )}
        </div>

        {error && <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
          <Button loading={busy === 'save'} onClick={save}>Salvar e testar</Button>
        </div>
      </div>
    </Modal>
  );
}
