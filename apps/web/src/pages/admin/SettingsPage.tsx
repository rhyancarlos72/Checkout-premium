import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Crown, Eye, EyeOff, ImageIcon, KeyRound, Trash2, UserPlus, Users, LogOut, Mail, MonitorSmartphone, Shield, ShieldCheck, ShieldOff, Store, Target, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, cn, Field, Input, PageLoader, Switch, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMe } from '@/lib/me';
import { maskEmail, useHideEmail } from '@/lib/privacy';
import { BrandMark, defaultBrand, type Brand } from '@/lib/brand';
import { ImageUpload } from '@/components/ImageUpload';
import { centsToInput, parseMoney } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { PageHeader } from './AdminApp';

interface Settings {
  recovery: { enabled: boolean; delayMinutes: number };
  goal: { monthlyCents: number };
  store: { name: string; supportEmail: string; document: string };
  brand: Brand;
}

const tabs = [
  { key: 'perfil', label: 'Perfil', icon: User },
  { key: 'seguranca', label: 'Segurança', icon: Shield },
  { key: 'loja', label: 'Loja e metas', icon: Store },
  { key: 'marca', label: 'Logo do sistema', icon: ImageIcon },
  { key: 'equipe', label: 'Equipe', icon: Users, ownerOnly: true },
] as const;

function Panel({ title, desc, icon, children, footer }: { title: string; desc?: string; icon: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="flex gap-4 border-b border-zinc-100 p-6">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">{icon}</div>
        <div>
          <h2 className="font-display text-lg font-semibold text-zinc-900">{title}</h2>
          {desc && <p className="mt-0.5 text-sm text-zinc-500">{desc}</p>}
        </div>
      </div>
      <div className="space-y-4 p-6">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50 px-6 py-4">{footer}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ perfil
function ProfileTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const { session } = useAuth();
  const user = session?.user;
  const [name, setName] = useState((user?.user_metadata?.full_name as string) ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const priv = useHideEmail();

  async function saveName() {
    setBusy('name');
    const { error } = await supabase.auth.updateUser({ data: { full_name: name.trim() } });
    setBusy(null);
    error ? toast.err(error.message) : toast.ok('Nome atualizado');
  }
  async function saveEmail() {
    if (email.trim().toLowerCase() === user?.email) return;
    setBusy('email');
    const { error } = await supabase.auth.updateUser({ email: email.trim() }, { emailRedirectTo: `${window.location.origin}/admin/configuracoes` });
    setBusy(null);
    error ? toast.err(error.message) : toast.ok('Enviamos um link de confirmação para o novo e-mail (e para o atual).');
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel title="Seu nome" desc="Aparece no painel e na saudação." icon={<User className="h-5 w-5" />} footer={<Button loading={busy === 'name'} onClick={saveName}>Salvar nome</Button>}>
        <Field label="Nome completo"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Seu nome" autoComplete="name" /></Field>
      </Panel>
      <Panel title="E-mail de acesso" desc="Usado para entrar e para recuperar a senha." icon={<Mail className="h-5 w-5" />} footer={<Button loading={busy === 'email'} disabled={email.trim().toLowerCase() === user?.email} onClick={saveEmail}>Alterar e-mail</Button>}>
        <Field label="E-mail" hint="A troca só vale depois de confirmar pelo link enviado por e-mail.">
          <div className="flex gap-2">
            {priv.hidden ? (
              <Input value={maskEmail(email)} readOnly onFocus={priv.toggle} className="font-mono" aria-label="E-mail (oculto)" />
            ) : (
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            )}
            <Button variant="secondary" className="h-12 shrink-0" onClick={priv.toggle} aria-label={priv.hidden ? 'Mostrar e-mail' : 'Esconder e-mail'}>{priv.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
          </div>
        </Field>
        {user?.new_email && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">Aguardando confirmação de <b>{priv.show(user.new_email)}</b>.</p>}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ segurança
function SecurityTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState({ next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);

  const factors = useQuery({ queryKey: ['mfa-factors'], queryFn: async () => (await supabase.auth.mfa.listFactors()).data });
  const verified = factors.data?.totp?.find((f) => f.status === 'verified');

  async function changePassword() {
    if (pw.next.length < 8) return toast.err('Use pelo menos 8 caracteres');
    if (pw.next !== pw.confirm) return toast.err('As senhas não conferem');
    setPwBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw.next });
    setPwBusy(false);
    if (error) return toast.err(/reauthenticat|recent/i.test(error.message) ? 'Por segurança, saia e entre de novo antes de trocar a senha.' : error.message);
    setPw({ next: '', confirm: '' });
    toast.ok('Senha alterada');
  }

  async function startEnroll() {
    setMfaBusy(true);
    // remove tentativas anteriores não concluídas
    for (const f of factors.data?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Painel ${new Date().toLocaleDateString('pt-BR')} ${Date.now() % 10000}` });
    setMfaBusy(false);
    if (error || !data) return toast.err(error?.message ?? 'Não foi possível iniciar');
    setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
  }

  async function confirmEnroll() {
    if (!enroll) return;
    setMfaBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.factorId, code });
    setMfaBusy(false);
    if (error) return toast.err(/invalid/i.test(error.message) ? 'Código inválido. Use o código atual do app.' : error.message);
    setEnroll(null);
    qc.invalidateQueries({ queryKey: ['mfa-factors'] });
    toast.ok('Verificação em 2 etapas ativada!');
  }

  async function disableMfa() {
    if (!verified || !confirm('Desativar a verificação em 2 etapas? Sua conta ficará menos protegida.')) return;
    setMfaBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: verified.id });
    setMfaBusy(false);
    if (error) return toast.err(error.message);
    await supabase.auth.refreshSession();
    qc.invalidateQueries({ queryKey: ['mfa-factors'] });
    toast.ok('Verificação em 2 etapas desativada');
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel
        title="Verificação em 2 etapas"
        desc="Além da senha, pede um código do app autenticador ao entrar."
        icon={<ShieldCheck className="h-5 w-5" />}
      >
        {factors.isLoading ? (
          <PageLoader />
        ) : verified ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" />
              <div className="flex-1">
                <p className="font-semibold text-emerald-800">Ativada</p>
                <p className="text-sm text-emerald-700">Sua conta pede o código do autenticador em cada login.</p>
              </div>
            </div>
            <Button variant="secondary" loading={mfaBusy} onClick={disableMfa}><ShieldOff className="h-4 w-4" /> Desativar</Button>
          </div>
        ) : enroll ? (
          <div className="space-y-4">
            <ol className="space-y-1.5 text-sm text-zinc-600">
              <li>1. Abra o Google Authenticator, Authy ou 1Password.</li>
              <li>2. Escaneie o QR Code (ou digite a chave manualmente).</li>
              <li>3. Digite o código de 6 dígitos que aparecer.</li>
            </ol>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="rounded-2xl bg-[#fff] p-3 shadow-sm ring-1 ring-zinc-200">
                <img src={enroll.qr} alt="QR Code do autenticador" className="h-44 w-44" />
              </div>
              <div className="w-full min-w-0 flex-1 space-y-3">
                <Field label="Chave manual">
                  <div className="flex gap-2">
                    <Input value={enroll.secret} readOnly className="font-mono text-sm" />
                    <Button variant="secondary" className="h-12 shrink-0" onClick={() => navigator.clipboard.writeText(enroll.secret).then(() => toast.ok('Chave copiada'))} aria-label="Copiar chave"><Copy className="h-4 w-4" /></Button>
                  </div>
                </Field>
                <Field label="Código do app">
                  <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" className="text-center font-mono text-xl tracking-[.4em]" />
                </Field>
                <div className="flex gap-2">
                  <Button loading={mfaBusy} disabled={code.length !== 6} onClick={confirmEnroll}>Ativar</Button>
                  <Button variant="ghost" onClick={() => setEnroll(null)}>Cancelar</Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <ShieldOff className="h-6 w-6 shrink-0 text-amber-600" />
              <p className="text-sm text-amber-800">Desativada. Recomendamos ativar: protege seu painel e suas vendas mesmo se a senha vazar.</p>
            </div>
            <Button loading={mfaBusy} onClick={startEnroll}><ShieldCheck className="h-4 w-4" /> Ativar verificação em 2 etapas</Button>
          </div>
        )}
      </Panel>

      <div className="space-y-6">
        <Panel title="Alterar senha" icon={<KeyRound className="h-5 w-5" />} footer={<Button loading={pwBusy} onClick={changePassword}>Salvar nova senha</Button>}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Nova senha"><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
            <Field label="Confirmar"><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></Field>
          </div>
        </Panel>
        <Panel title="Sessões" desc="Encerre o acesso em outros navegadores e aparelhos." icon={<MonitorSmartphone className="h-5 w-5" />}>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={async () => {
              const { error } = await supabase.auth.signOut({ scope: 'others' });
              error ? toast.err(error.message) : toast.ok('Outras sessões encerradas');
            }}><LogOut className="h-4 w-4" /> Sair dos outros dispositivos</Button>
            <Button variant="ghost" onClick={() => supabase.auth.signOut({ scope: 'global' })}>Sair de todos (inclusive deste)</Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ loja
function StoreTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => adminApi.get<Settings>('/settings') });
  const [s, setS] = useState<Settings | null>(null);
  const [goal, setGoal] = useState('');
  useEffect(() => {
    if (settings.data) {
      setS(settings.data);
      setGoal(centsToInput(settings.data.goal?.monthlyCents ?? 10_000_000));
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (v: Settings) => adminApi.put<Settings>('/settings', v),
    onSuccess: () => {
      toast.ok('Configurações salvas');
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['progress'] });
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  if (!s) return <PageLoader />;
  const submit = () => save.mutate({ ...s, goal: { monthlyCents: parseMoney(goal) } });

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel title="Dados da loja" desc="Usados nos e-mails e no rodapé do checkout (quando preenchidos)." icon={<Store className="h-5 w-5" />} footer={<Button loading={save.isPending} onClick={submit}>Salvar</Button>}>
        <Field label="Nome da loja (e-mails)"><Input value={s.store.name} onChange={(e) => setS({ ...s, store: { ...s.store, name: e.target.value } })} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="E-mail de suporte"><Input type="email" value={s.store.supportEmail} onChange={(e) => setS({ ...s, store: { ...s.store, supportEmail: e.target.value } })} /></Field>
          <Field label="CNPJ/CPF"><Input value={s.store.document} onChange={(e) => setS({ ...s, store: { ...s.store, document: e.target.value } })} /></Field>
        </div>
      </Panel>
      <div className="space-y-6">
        <Panel title="Meta de faturamento" desc="Acompanhe o progresso no card da barra lateral." icon={<Target className="h-5 w-5" />} footer={<Button loading={save.isPending} onClick={submit}>Salvar meta</Button>}>
          <Field label="Meta mensal (R$)"><Input value={goal} onChange={(e) => setGoal(e.target.value)} inputMode="decimal" placeholder="100.000,00" /></Field>
        </Panel>
        <Panel title="Recuperação de Pix pendente" icon={<Mail className="h-5 w-5" />} footer={<Button loading={save.isPending} onClick={submit}>Salvar</Button>}>
          <Switch checked={s.recovery.enabled} onChange={(v) => setS({ ...s, recovery: { ...s.recovery, enabled: v } })} label="Enviar e-mail para quem gerou o Pix e não pagou" />
          <Field label="Enviar após (minutos)"><Input type="number" min={5} max={1440} value={s.recovery.delayMinutes} onChange={(e) => setS({ ...s, recovery: { ...s.recovery, delayMinutes: Number(e.target.value) } })} /></Field>
        </Panel>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ marca
function BrandTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => adminApi.get<Settings>('/settings') });
  const [b, setB] = useState<Brand | null>(null);
  useEffect(() => {
    if (settings.data) setB({ ...defaultBrand, ...settings.data.brand });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (brand: Brand) => adminApi.put<Settings>('/settings', { ...settings.data, brand: { ...brand, name: brand.name.trim() || defaultBrand.name } }),
    onSuccess: (v) => {
      toast.ok('Logo salva');
      qc.setQueryData(['settings'], v);
      qc.setQueryData(['brand'], v.brand);
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  if (!b) return <PageLoader />;
  const isDefault = (b.name.trim() || defaultBrand.name) === defaultBrand.name;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel
        title="Logo do sistema"
        desc="Aparece na barra lateral do painel, na tela de login e no ícone da aba do navegador."
        icon={<ImageIcon className="h-5 w-5" />}
        footer={<Button loading={save.isPending} onClick={() => save.mutate(b)}>Salvar logo</Button>}
      >
        <ImageUpload label="Arquivo da logo" accept="image/png,image/svg+xml,image/webp,image/jpeg" value={b.logoUrl} onChange={(url) => setB({ ...b, logoUrl: url })} />
        <p className="-mt-2 text-xs text-zinc-500">Use uma imagem quadrada (ex.: 512×512), PNG ou SVG com fundo transparente. Até 5 MB.</p>
        <Field label="Nome do sistema" hint="Mostrado ao lado da logo."><Input value={b.name} maxLength={40} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder={defaultBrand.name} /></Field>
        <Switch checked={b.logoBg} onChange={(v) => setB({ ...b, logoBg: v })} label="Fundo branco atrás da logo (melhor para logos escuras no painel escuro)" />
      </Panel>

      <Panel title="Pré-visualização" desc="Como fica no painel e no login." icon={<MonitorSmartphone className="h-5 w-5" />}>
        <div className="flex items-center gap-3 rounded-2xl bg-[#0d1426] p-5">
          <BrandMark brand={b} className="h-9 w-9" iconClassName="h-[18px] w-[18px]" />
          <div className="min-w-0 font-display leading-tight">
            <p className="truncate font-semibold tracking-tight text-[#fff]">{isDefault ? 'Checkout' : b.name.trim()}</p>
            <p className="text-[11px] font-medium uppercase tracking-widest text-blue-300/80">{isDefault ? 'Premium' : 'Painel'}</p>
          </div>
        </div>
        <div className="flex items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-[#05070d] to-[#0b1324] p-6">
          <BrandMark brand={b} className="h-11 w-11 rounded-2xl" iconClassName="h-5 w-5" fallbackClassName="bg-gradient-to-br from-emerald-400 to-cyan-500" />
          <span className="truncate text-lg font-semibold tracking-tight text-[#fff]">{b.name.trim() || defaultBrand.name}</span>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
          {b.logoUrl ? <img src={b.logoUrl} alt="" className="h-4 w-4 object-contain" /> : <ImageIcon className="h-4 w-4" />}
          <span className="truncate">Aba do navegador · {b.name.trim() || defaultBrand.name}</span>
        </div>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ equipe (somente o dono)
interface AccessRequest { id: string; name: string; email: string; phone: string | null; company: string | null; message: string | null; created_at: string }
interface Member { user_id: string; email: string; name: string; role: 'owner' | 'staff'; created_at: string; last_sign_in_at: string | null }
function TeamTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: () => adminApi.get<Member[]>('/team') });
  const priv = useHideEmail();
  const requests = useQuery({ queryKey: ['team-requests'], queryFn: () => adminApi.get<AccessRequest[]>('/team/requests') });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => adminApi.post<{ message: string }>(`/team/requests/${id}/${action}`),
    onSuccess: (r) => (toast.ok(r.message), qc.invalidateQueries({ queryKey: ['team-requests'] }), qc.invalidateQueries({ queryKey: ['team'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const [email, setEmail] = useState('');
  const invite = useMutation({
    mutationFn: () => adminApi.post<{ message: string }>('/team', { email }),
    onSuccess: (r) => (toast.ok(r.message), setEmail(''), qc.invalidateQueries({ queryKey: ['team'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao convidar'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => adminApi.del(`/team/${id}`),
    onSuccess: () => (toast.ok('Acesso removido'), qc.invalidateQueries({ queryKey: ['team'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao remover'),
  });
  return (
    <div className="space-y-6">
      {(requests.data?.length ?? 0) > 0 && (
        <Panel title={`Pedidos de cadastro (${requests.data!.length})`} desc="Pessoas que pediram acesso pela tela de login. Aprovar envia o convite (acesso de equipe, sem integrações)." icon={<UserPlus className="h-5 w-5" />}>
          <ul className="divide-y divide-zinc-100">
            {requests.data!.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-900">{r.name}{r.company ? <span className="font-normal text-zinc-500"> · {r.company}</span> : null}</p>
                  <p className="truncate text-xs text-zinc-500">{r.email}{r.phone ? ` · ${r.phone}` : ''} · {new Date(r.created_at).toLocaleString('pt-BR')}</p>
                  {r.message && <p className="mt-1 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600">“{r.message}”</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" loading={decide.isPending && decide.variables?.id === r.id && decide.variables.action === 'approve'} onClick={() => decide.mutate({ id: r.id, action: 'approve' })}>Aprovar</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Recusar o pedido de ${r.name}?`) && decide.mutate({ id: r.id, action: 'reject' })}>Recusar</Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Panel title="Adicionar pessoa à equipe" desc="A pessoa recebe um e-mail para criar a senha." icon={<UserPlus className="h-5 w-5" />} footer={<Button loading={invite.isPending} disabled={!email.includes('@')} onClick={() => invite.mutate()}>Enviar convite</Button>}>
        <Field label="E-mail"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@email.com" /></Field>
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
          <p className="font-semibold text-zinc-800">O que a equipe pode fazer</p>
          <p className="mt-1">Dashboard, produtos, checkouts, order bumps, cupons, vendas, clientes e as próprias configurações de perfil.</p>
          <p className="mt-2 font-semibold text-zinc-800">Somente você (dono)</p>
          <p className="mt-1">Integrações: Woovi, Efí Bank, WhatsApp (Evolution), webhooks/PayTracking e a gestão da equipe. As credenciais também ficam bloqueadas no banco de dados para a equipe.</p>
        </div>
      </Panel>
      <Panel title="Quem tem acesso" icon={<Users className="h-5 w-5" />}>
        {team.isLoading ? <PageLoader /> : (
          <ul className="divide-y divide-zinc-100">
            {(team.data ?? []).map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 py-3">
                <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-semibold', m.role === 'owner' ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-600')}>{m.role === 'owner' ? <Crown className="h-4 w-4" /> : (m.name || m.email).charAt(0).toUpperCase()}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900">{m.name || (m.role === 'owner' ? priv.show(m.email) : m.email)}</p>
                  <p className="truncate text-xs text-zinc-500">{m.name ? `${m.role === 'owner' ? priv.show(m.email) : m.email} · ` : ''}{m.role === 'owner' ? 'Dono · acesso total' : m.last_sign_in_at ? 'Equipe' : 'Equipe · convite pendente'}</p>
                </div>
                {m.role !== 'owner' && (
                  <Button size="sm" variant="ghost" aria-label="Remover acesso" onClick={() => confirm(`Remover o acesso de ${m.email}?`) && remove.mutate(m.user_id)}><Trash2 className="h-4 w-4" /></Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
    </div>
  );
}

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (tabs.find((t) => t.key === params.get('tab'))?.key ?? 'perfil') as (typeof tabs)[number]['key'];
  const toast = useToast();
  const isOwner = useMe().data?.role === 'owner';
  return (
    <>
      <PageHeader title="Configurações" subtitle="Sua conta, segurança e preferências da loja" />
      <div className="mb-6 inline-flex flex-wrap gap-1 rounded-2xl border border-zinc-200 bg-white p-1.5">
        {tabs.filter((t) => !('ownerOnly' in t && t.ownerOnly) || isOwner).map((t) => (
          <button key={t.key} onClick={() => setParams({ tab: t.key })} className={cn('flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition', tab === t.key ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-600/25' : 'text-zinc-600 hover:bg-zinc-100')}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'perfil' && <ProfileTab toast={toast} />}
      {tab === 'seguranca' && <SecurityTab toast={toast} />}
      {tab === 'loja' && <StoreTab toast={toast} />}
      {tab === 'marca' && <BrandTab toast={toast} />}
      {tab === 'equipe' && isOwner && <TeamTab toast={toast} />}
      {toast.node}
    </>
  );
}
