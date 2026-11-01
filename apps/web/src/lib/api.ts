// Supabase só é carregado nas rotas do painel (mantém o checkout leve)
const sb = () => import('./supabase').then((m) => m.supabase);

export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const { data } = await (await sb()).auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (auth && res.status === 401 && json.code !== 'MFA_REQUIRED') await (await sb()).auth.signOut();
    throw new ApiError(res.status, json.error ?? 'Erro inesperado', json.issues);
  }
  return json as T;
}

export const publicApi = {
  get: <T,>(p: string) => request<T>('GET', `/public${p}`),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', `/public${p}`, b ?? {}),
};

export const adminApi = {
  get: <T,>(p: string) => request<T>('GET', `/admin${p}`, undefined, true),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', `/admin${p}`, b ?? {}, true),
  put: <T,>(p: string, b: unknown) => request<T>('PUT', `/admin${p}`, b, true),
  del: (p: string) => request<void>('DELETE', `/admin${p}`, undefined, true),
  async download(p: string, filename: string) {
    const { data } = await (await sb()).auth.getSession();
    const res = await fetch(`/api/admin${p}`, { headers: { Authorization: `Bearer ${data.session?.access_token}` } });
    if (!res.ok) throw new ApiError(res.status, 'Falha ao exportar');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  },
};
