import { ApiError } from '@/lib/api';

const KEY = 'ck_member_session';
export const memberSession = {
  get: () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (t: string) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* navegação privada: a sessão vale só nesta aba */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const s = memberSession.get();
  if (s) headers.Authorization = `Member ${s}`;
  const res = await fetch(`/api/members${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) memberSession.clear();
    throw new ApiError(res.status, json.error ?? 'Erro inesperado');
  }
  return json as T;
}
export const membersApi = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
};

export interface ModuleCard {
  id: string;
  title: string;
  subtitle: string | null;
  cover_url: string | null;
  lessons: number;
  completed: number;
}
export interface Course {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  banner_url: string | null;
  progress: { total: number; completed: number };
  sections: { id: string; title: string; modules: ModuleCard[] }[];
}
export interface Extra {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  modules: number;
  checkout_url: string;
  code: string | null;
}
export interface Home {
  customer: { name: string; email: string } | null;
  courses: Course[];
  extras: Extra[];
}
export interface Lesson {
  id: string;
  title: string;
  description: string | null;
  video_url: string | null;
  duration: string | null;
  attachments: { name: string; url: string }[];
  completed: boolean;
}
export interface ModuleDetail {
  id: string;
  title: string;
  subtitle: string | null;
  cover_url: string | null;
  course: string;
  next_module: { id: string; title: string } | null;
  lessons: Lesson[];
}
