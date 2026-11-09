import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Download, LayoutGrid, Lock, LogOut, Mail, Play, PlayCircle, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { cn } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { videoSource } from '@/lib/video';
import { memberSession, membersApi, type Course, type Extra, type Home, type ModuleCard, type ModuleDetail } from './api';

/** Área de membros do aluno (estilo Netflix): /membros */
export default function MembersApp() {
  useEffect(() => {
    document.title = 'Área de membros';
    document.documentElement.classList.add('members-dark');
    return () => document.documentElement.classList.remove('members-dark');
  }, []);
  return (
    <div className="members min-h-dvh bg-[#07080c] font-checkout text-white antialiased">
      <Routes>
        <Route path="entrar" element={<EnterWithOrder />} />
        <Route path="login" element={<Login />} />
        <Route path="modulo/:id" element={<RequireSession><ModulePage /></RequireSession>} />
        <Route path="*" element={<RequireSession><HomePage /></RequireSession>} />
      </Routes>
    </div>
  );
}

function RequireSession({ children }: { children: ReactNode }) {
  if (!memberSession.get()) return <Navigate to="/membros/login" replace />;
  return <>{children}</>;
}

function Loader() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="h-9 w-9 animate-spin rounded-full border-[3px] border-white/15 border-t-blue-500" />
    </div>
  );
}

// ------------------------------------------------------------------ entrada pelo link do pedido
function EnterWithOrder() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const token = params.get('o') ?? '';
  useEffect(() => {
    if (!/^[a-f0-9]{48}$/.test(token)) return setError('Link de acesso inválido.');
    membersApi
      .post<{ token: string }>('/login/order', { token })
      .then((r) => {
        memberSession.set(r.token);
        navigate('/membros', { replace: true });
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Não foi possível entrar agora.'));
  }, [token, navigate]);
  if (!error) return <Loader />;
  return (
    <AuthShell title="Não foi possível entrar" subtitle={error}>
      <Link to="/membros/login" className="flex h-12 w-full items-center justify-center rounded-xl bg-blue-600 font-semibold transition hover:bg-blue-500">
        Entrar com meu e-mail
      </Link>
    </AuthShell>
  );
}

// ------------------------------------------------------------------ login por código
function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-blue-600/20 blur-[120px]" />
      <div className="relative w-full max-w-[400px] rounded-2xl border border-white/10 bg-white/[.04] p-7 shadow-2xl backdrop-blur">
        <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/20 text-blue-400"><PlayCircle className="h-6 w-6" /></span>
        <h1 className="text-[22px] font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[14px] leading-relaxed text-white/60">{subtitle}</p>}
        <div className="mt-6 space-y-3">{children}</div>
      </div>
    </div>
  );
}

const inputCls = 'h-12 w-full rounded-xl border border-white/10 bg-white/[.06] px-4 text-[15px] text-white placeholder:text-white/35 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30';

function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [error, setError] = useState<string | null>(null);
  const ask = useMutation({
    mutationFn: () => membersApi.post('/login/code', { email }),
    onSuccess: () => (setStep('code'), setError(null)),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Tente novamente.'),
  });
  const verify = useMutation({
    mutationFn: () => membersApi.post<{ token: string }>('/login/verify', { email, code }),
    onSuccess: (r) => {
      memberSession.set(r.token);
      navigate('/membros', { replace: true });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Tente novamente.'),
  });
  if (memberSession.get()) return <Navigate to="/membros" replace />;
  return step === 'email' ? (
    <AuthShell title="Área de membros" subtitle="Digite o e-mail usado na compra. Enviamos um código de acesso para você.">
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), ask.mutate())}>
        <input className={inputCls} type="email" required autoComplete="email" inputMode="email" placeholder="seu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={ask.isPending} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 font-semibold transition hover:bg-blue-500 disabled:opacity-60">
          <Mail className="h-4 w-4" /> {ask.isPending ? 'Enviando…' : 'Receber código'}
        </button>
      </form>
    </AuthShell>
  ) : (
    <AuthShell title="Confira seu e-mail" subtitle={`Se ${email} tiver uma compra, o código de 6 dígitos chega em instantes (veja também o spam).`}>
      <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), verify.mutate())}>
        <input className={cn(inputCls, 'text-center text-2xl font-bold tracking-[.5em]')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Código" autoFocus />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={verify.isPending || code.length !== 6} className="flex h-12 w-full items-center justify-center rounded-xl bg-blue-600 font-semibold transition hover:bg-blue-500 disabled:opacity-60">
          {verify.isPending ? 'Entrando…' : 'Entrar'}
        </button>
        <button type="button" onClick={() => (setStep('email'), setCode(''), setError(null))} className="w-full text-sm text-white/55 hover:text-white">
          Usar outro e-mail
        </button>
      </form>
    </AuthShell>
  );
}

// ------------------------------------------------------------------ topo
type Store = { name: string; logo_url: string | null };
function TopBar({ store, back, overlay }: { store?: Store; back?: ReactNode; overlay?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [solid, setSolid] = useState(!overlay);
  useEffect(() => {
    if (!overlay) return;
    const on = () => setSolid(window.scrollY > 40);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, [overlay]);
  return (
    <header className={cn('top-0 z-40 w-full transition-colors duration-300', overlay ? 'fixed' : 'sticky', solid ? 'border-b border-white/5 bg-[#07080c]/95 backdrop-blur-md' : 'bg-gradient-to-b from-black/80 to-transparent')}>
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-3 px-4 sm:h-[72px] sm:px-10">
        <div className="flex min-w-0 items-center gap-3">
          {back}
          {store?.logo_url ? <img src={store.logo_url} alt={store.name} className="h-8 w-auto max-w-[160px] object-contain" /> : <span className="truncate text-[18px] font-extrabold tracking-tight">{store?.name ?? 'Área de membros'}</span>}
        </div>
        <button
          onClick={() => {
            memberSession.clear();
            qc.clear();
            navigate('/membros/login', { replace: true });
          }}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" /> Sair
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ início
function useHome() {
  return useQuery({ queryKey: ['members', 'home'], queryFn: () => membersApi.get<Home & { store: Store }>('/me'), retry: false });
}

const allModules = (c: Course) => c.sections.flatMap((s) => s.modules);
/** Próximo módulo a assistir: o primeiro com aula pendente (ou o primeiro de todos). */
const nextModuleOf = (c: Course) => allModules(c).find((m) => m.completed < m.lessons) ?? allModules(c)[0];

function HomePage() {
  const { data, isLoading, error } = useHome();
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/membros/login" replace />;
  if (isLoading || !data) return <Loader />;
  const first = (data.customer?.name ?? '').trim().split(/\s+/)[0];
  // destaque: o curso em andamento (ou o primeiro)
  const featured = data.courses.find((c) => c.progress.completed > 0 && c.progress.completed < c.progress.total) ?? data.courses[0];
  const watching = data.courses.flatMap((c) => allModules(c).filter((m) => m.completed > 0 && m.completed < m.lessons));
  return (
    <>
      <TopBar store={data.store} overlay />
      {featured ? (
        <Hero course={featured} greeting={first} />
      ) : (
        <div className="px-4 pb-6 pt-28 sm:px-10">
          <h1 className="text-[28px] font-extrabold tracking-tight">Olá{first ? `, ${cap(first)}` : ''}!</h1>
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[.03] p-8 text-center">
            <p className="font-semibold">Nenhum conteúdo liberado ainda</p>
            <p className="mt-1 text-sm text-white/55">Assim que o pagamento for confirmado, seus cursos aparecem aqui.</p>
          </div>
        </div>
      )}
      <main id="conteudo" className={cn('relative z-10 mx-auto max-w-[1600px] pb-24', featured && '-mt-16 sm:-mt-28')}>
        {watching.length > 0 && (
          <Row title="Continue assistindo" accent="bg-red-500">
            {watching.map((m) => <PosterCard key={m.id} module={m} />)}
          </Row>
        )}
        {data.courses.map((c) => (
          <div key={c.id}>
            {data.courses.length > 1 && <p className="mt-12 px-4 text-[13px] font-bold uppercase tracking-[.25em] text-white/45 sm:px-10">{c.name}</p>}
            {c.sections.map((s) => (
              <Row key={s.id} title={s.title} count={`${s.modules.length} ${s.modules.length === 1 ? 'módulo' : 'módulos'}`}>
                {s.modules.map((m) => <PosterCard key={m.id} module={m} />)}
              </Row>
            ))}
          </div>
        ))}
        {data.extras.length > 0 && <ExtrasRow extras={data.extras} />}
      </main>
    </>
  );
}

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

function Hero({ course, greeting }: { course: Course; greeting?: string }) {
  const next = nextModuleOf(course);
  const cover = allModules(course).find((m) => m.cover_url)?.cover_url ?? course.image_url;
  const bg = course.banner_url || cover;
  const pct = course.progress.total ? Math.round((course.progress.completed / course.progress.total) * 100) : 0;
  const modules = allModules(course).length;
  return (
    <section className="relative h-[74svh] min-h-[540px] max-h-[880px] w-full overflow-hidden">
      {bg && (
        <img
          src={bg}
          alt=""
          fetchPriority="high"
          className={cn('absolute inset-0 h-full w-full object-cover', course.banner_url ? 'object-center' : 'scale-125 object-top opacity-50 blur-2xl')}
        />
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_20%,rgba(37,99,235,.25),transparent_60%)]" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#07080c] via-[#07080c]/75 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-[#07080c] via-[#07080c]/70 to-transparent" />
      {/* sem banner: a capa do módulo aparece inteira à direita, como um pôster */}
      {!course.banner_url && cover && (
        <img src={cover} alt="" className="members-float absolute right-[8%] top-1/2 hidden h-[64%] rounded-2xl object-cover shadow-[0_30px_80px_-20px_rgba(0,0,0,.9)] ring-1 ring-white/15 lg:block" style={{ aspectRatio: '2 / 3' }} />
      )}
      <div className="relative mx-auto flex h-full max-w-[1600px] flex-col justify-end px-4 pb-24 sm:px-10 sm:pb-36">
        <div className="max-w-[640px]">
          {greeting && <p className="mb-3 text-[14px] text-white/70">Olá, {cap(greeting)} 👋</p>}
          <p className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[.3em] text-blue-400">
            <span className="h-[2px] w-6 bg-blue-500" /> Seu curso
          </p>
          <h1 className="mt-3 text-[38px] font-black leading-[1.02] tracking-tight drop-shadow-xl sm:text-[64px]">{course.name}</h1>
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-white/75">
            {pct > 0 && <span className="font-bold text-emerald-400">{pct}% concluído</span>}
            <span>{modules} {modules === 1 ? 'módulo' : 'módulos'}</span>
            <span className="h-1 w-1 rounded-full bg-white/40" />
            <span>{course.progress.total} aulas</span>
          </p>
          {course.description && <p className="mt-3 line-clamp-3 max-w-[560px] text-[15px] leading-relaxed text-white/80 sm:text-[17px]">{course.description}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {next && (
              <Link to={`/membros/modulo/${next.id}`} className="inline-flex h-12 items-center gap-2.5 rounded-md bg-white px-7 text-[16px] font-bold text-black shadow-lg transition hover:bg-white/80 sm:h-14 sm:px-9 sm:text-[18px]">
                <Play className="h-5 w-5 fill-current sm:h-6 sm:w-6" /> {pct > 0 ? 'Continuar' : 'Assistir'}
              </Link>
            )}
            <button onClick={() => document.getElementById('conteudo')?.scrollIntoView({ behavior: 'smooth' })} className="inline-flex h-12 items-center gap-2.5 rounded-md bg-white/20 px-6 text-[16px] font-bold backdrop-blur-md transition hover:bg-white/30 sm:h-14 sm:px-8 sm:text-[18px]">
              <LayoutGrid className="h-5 w-5" /> Ver módulos
            </button>
          </div>
          {pct > 0 && (
            <div className="mt-6 h-1 w-full max-w-[360px] overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-red-500" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Fileira horizontal com rolagem (arrastar no celular, setas no computador). */
function Row({ title, count, children, accent = 'bg-blue-500' }: { title: string; count?: string; children: ReactNode; accent?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section className="group/row relative mt-10 first:mt-0">
      <div className="flex items-end gap-3 px-4 sm:px-10">
        <span className={cn('mb-1 h-7 w-1 rounded-full', accent)} />
        <h2 className="text-[19px] font-bold leading-tight tracking-tight sm:text-[24px]">{title}</h2>
        {count && <span className="mb-[3px] text-[13px] text-white/45">{count}</span>}
      </div>
      <div ref={ref} className="members-row flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-6 pt-4 sm:gap-4 sm:scroll-px-10 sm:px-10">
        {children}
      </div>
      <button onClick={() => scroll(-1)} aria-label="Voltar" className="absolute bottom-6 left-0 top-[52px] z-20 hidden w-10 items-center justify-center bg-gradient-to-r from-[#07080c] to-transparent text-white opacity-0 transition group-hover/row:opacity-100 md:flex"><ChevronLeft className="h-9 w-9" /></button>
      <button onClick={() => scroll(1)} aria-label="Avançar" className="absolute bottom-6 right-0 top-[52px] z-20 hidden w-10 items-center justify-center bg-gradient-to-l from-[#07080c] to-transparent text-white opacity-0 transition group-hover/row:opacity-100 md:flex"><ChevronRight className="h-9 w-9" /></button>
    </section>
  );
}

const cardCls = 'relative w-[40vw] max-w-[220px] shrink-0 snap-start overflow-hidden rounded-xl bg-[#101219] ring-1 ring-white/10 transition duration-300 ease-out sm:w-[210px] md:hover:z-10 md:hover:scale-[1.07] md:hover:shadow-[0_20px_50px_-12px_rgba(0,0,0,.9)] md:hover:ring-white/40';

function Cover({ src, title, subtitle, locked }: { src: string | null; title: string; subtitle?: string | null; locked?: boolean }) {
  return (
    <div className="relative aspect-[2/3] w-full overflow-hidden bg-gradient-to-b from-[#0b2a8a] via-[#050816] to-black">
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" className={cn('h-full w-full object-cover', locked && 'brightness-[.4] saturate-50')} />
      ) : (
        <div className={cn('flex h-full flex-col items-center justify-center px-4 text-center', locked && 'opacity-50')}>
          <span className="text-[11px] font-medium uppercase tracking-[.35em] text-white/60">Módulo</span>
          <span className="mt-3 line-clamp-4 text-[19px] font-black uppercase leading-tight tracking-[.06em]">{title}</span>
          {subtitle && <span className="mt-3 line-clamp-2 text-[10.5px] uppercase tracking-[.22em] text-blue-300/80">{subtitle}</span>}
        </div>
      )}
      {locked ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/60 ring-1 ring-amber-300/50 backdrop-blur"><Lock className="h-6 w-6 text-amber-300" /></span>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition duration-300 group-hover:bg-black/35 group-hover:opacity-100">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-2xl"><Play className="ml-0.5 h-6 w-6 fill-current" /></span>
        </div>
      )}
    </div>
  );
}

function PosterCard({ module: m }: { module: ModuleCard }) {
  const pct = m.lessons ? Math.round((m.completed / m.lessons) * 100) : 0;
  return (
    <Link to={`/membros/modulo/${m.id}`} className={cn(cardCls, 'group')}>
      <Cover src={m.cover_url} title={m.title} subtitle={m.subtitle} />
      {pct === 100 && <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-black shadow-lg"><Check className="h-4 w-4" strokeWidth={3} /></span>}
      <div className="h-[3px] bg-white/10">{pct > 0 && <div className="h-full bg-red-500" style={{ width: `${pct}%` }} />}</div>
      <div className="px-3 py-3 text-center">
        <p className="line-clamp-2 text-[13.5px] font-semibold leading-snug">{m.subtitle || m.title}</p>
        <p className="mt-1 text-[11.5px] text-white/45">{m.lessons} {m.lessons === 1 ? 'aula' : 'aulas'}{pct > 0 && pct < 100 ? ` · ${pct}%` : pct === 100 ? ' · concluído' : ''}</p>
      </div>
    </Link>
  );
}

function ExtrasRow({ extras }: { extras: Extra[] }) {
  return (
    <div className="mt-14">
      <div className="mx-4 mb-2 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent sm:mx-10" />
      <Row title="Cursos adicionais" count="Libere mais conteúdos" accent="bg-amber-400">
        {extras.map((x) => (
          <a key={x.id} href={x.checkout_url} className={cn(cardCls, 'group md:hover:ring-amber-300/60')}>
            <Cover src={x.cover_url} title={x.name} locked />
            <span className="absolute left-2 top-2 rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-black">Exclusivo</span>
            <div className="px-3 py-3 text-center">
              <p className="line-clamp-2 text-[13.5px] font-semibold leading-snug">{x.name}</p>
              <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-amber-300 to-amber-500 px-3 py-1.5 text-[12px] font-bold text-black shadow-md shadow-amber-500/20">
                <Sparkles className="h-3.5 w-3.5" /> Desbloquear
              </span>
            </div>
          </a>
        ))}
      </Row>
    </div>
  );
}

// ------------------------------------------------------------------ módulo / aula
function ModulePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const home = useHome();
  const q = useQuery({ queryKey: ['members', 'module', id], queryFn: () => membersApi.get<ModuleDetail>(`/modules/${id}`), retry: false });
  const lessons = q.data?.lessons ?? [];
  const current = useMemo(() => lessons.find((l) => l.id === params.get('aula')) ?? lessons.find((l) => !l.completed) ?? lessons[0], [lessons, params]);
  const idx = current ? lessons.indexOf(current) : -1;
  const toggle = useMutation({
    mutationFn: (v: { lesson: string; done: boolean }) => membersApi.post(`/lessons/${v.lesson}/progress`, { done: v.done }),
    onMutate: (v) => {
      qc.setQueryData<ModuleDetail>(['members', 'module', id], (d) => (d ? { ...d, lessons: d.lessons.map((l) => (l.id === v.lesson ? { ...l, completed: v.done } : l)) } : d));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['members', 'home'] }),
  });
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [current?.id]);

  if (q.error instanceof ApiError && q.error.status === 401) return <Navigate to="/membros/login" replace />;
  if (q.error) {
    return (
      <>
        <TopBar store={home.data?.store} back={<BackLink />} />
        <div className="mx-auto max-w-md px-4 py-20 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-white/5"><Lock className="h-6 w-6 text-white/70" /></span>
          <p className="mt-4 font-semibold">{q.error instanceof ApiError ? q.error.message : 'Não foi possível abrir este módulo.'}</p>
          <Link to="/membros" className="mt-5 inline-flex h-11 items-center rounded-xl bg-white/10 px-5 text-sm font-semibold hover:bg-white/15">Voltar ao início</Link>
        </div>
      </>
    );
  }
  if (!q.data) return <Loader />;
  const m = q.data;
  const go = (lessonId: string) => setParams({ aula: lessonId });
  const nextLesson = idx >= 0 ? lessons[idx + 1] : undefined;
  const video = videoSource(current?.video_url);

  return (
    <>
      <TopBar store={home.data?.store} back={<BackLink />} />
      <main className="mx-auto grid max-w-[1600px] gap-6 px-4 py-6 sm:px-10 lg:grid-cols-[minmax(0,1fr)_380px] lg:py-8">
        <div className="min-w-0">
          <p className="text-[13px] text-white/50">{m.course} · {m.title}</p>
          {current ? (
            <>
              <div className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-black">
                {video?.kind === 'iframe' ? (
                  <div className="relative aspect-video w-full">
                    <iframe key={current.id} src={video.src} title={current.title} className="absolute inset-0 h-full w-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
                  </div>
                ) : video?.kind === 'file' ? (
                  <video key={current.id} src={video.src} controls playsInline controlsList="nodownload" className="aspect-video w-full bg-black" />
                ) : (
                  <div className="flex aspect-video w-full flex-col items-center justify-center bg-gradient-to-br from-[#0b1a44] to-black px-6 text-center">
                    <PlayCircle className="h-10 w-10 text-white/40" />
                    <p className="mt-2 text-sm text-white/55">Esta aula não tem vídeo. Confira o conteúdo e os materiais abaixo.</p>
                  </div>
                )}
              </div>
              <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h1 className="text-[22px] font-bold leading-tight tracking-tight">{current.title}</h1>
                  <p className="mt-1 text-[13px] text-white/50">Aula {idx + 1} de {lessons.length}{current.duration ? ` · ${current.duration}` : ''}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => toggle.mutate({ lesson: current.id, done: !current.completed })}
                    className={cn('inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[14px] font-semibold transition', current.completed ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25' : 'bg-white/10 hover:bg-white/15')}
                  >
                    {current.completed ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />} {current.completed ? 'Concluída' : 'Marcar como concluída'}
                  </button>
                  {nextLesson ? (
                    <button
                      onClick={() => {
                        if (!current.completed) toggle.mutate({ lesson: current.id, done: true });
                        go(nextLesson.id);
                      }}
                      className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-[14px] font-semibold transition hover:bg-blue-500"
                    >
                      Próxima <ChevronRight className="h-4 w-4" />
                    </button>
                  ) : m.next_module ? (
                    <Link
                      to={`/membros/modulo/${m.next_module.id}`}
                      onClick={() => !current.completed && toggle.mutate({ lesson: current.id, done: true })}
                      className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-[14px] font-semibold transition hover:bg-blue-500"
                    >
                      Próximo módulo <ChevronRight className="h-4 w-4" />
                    </Link>
                  ) : null}
                </div>
              </div>
              {current.description && <div className="mt-5 whitespace-pre-line rounded-2xl border border-white/10 bg-white/[.03] p-5 text-[14.5px] leading-relaxed text-white/80">{current.description}</div>}
              {current.attachments.length > 0 && (
                <div className="mt-5">
                  <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-white/50">Materiais</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {current.attachments.map((a, i) => (
                      <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[.03] px-4 py-3 text-[14px] transition hover:border-blue-500/50 hover:bg-white/[.06]">
                        <Download className="h-4 w-4 shrink-0 text-blue-400" /> <span className="truncate">{a.name}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="mt-6 text-white/60">Este módulo ainda não tem aulas.</p>
          )}
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0e1016]">
            <div className="border-b border-white/10 px-4 py-3.5">
              <p className="font-semibold">{m.title}</p>
              <p className="text-[12px] text-white/50">{lessons.filter((l) => l.completed).length} de {lessons.length} aulas concluídas</p>
            </div>
            <ol className="max-h-[60vh] overflow-y-auto">
              {lessons.map((l, i) => (
                <li key={l.id}>
                  <button onClick={() => go(l.id)} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/5', l.id === current?.id && 'bg-blue-600/15')}>
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold', l.completed ? 'bg-emerald-500 text-black' : l.id === current?.id ? 'bg-blue-600' : 'bg-white/10 text-white/70')}>
                      {l.completed ? <Check className="h-4 w-4" /> : i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[14px] leading-snug">{l.title}</span>
                      {l.duration && <span className="text-[11.5px] text-white/45">{l.duration}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </main>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/membros" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/70 transition hover:bg-white/5 hover:text-white" aria-label="Voltar ao início">
      <ArrowLeft className="h-5 w-5" />
    </Link>
  );
}
