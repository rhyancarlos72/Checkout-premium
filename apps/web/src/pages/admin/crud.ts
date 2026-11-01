import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '@/lib/api';

export function useCrud<T extends { id: string }>(path: string) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: [path], queryFn: () => adminApi.get<T[]>(`/${path}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: [path] });
  const save = useMutation({
    mutationFn: ({ id, ...body }: Partial<T> & { id?: string }) => (id ? adminApi.put<T>(`/${path}/${id}`, body) : adminApi.post<T>(`/${path}`, body)),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => adminApi.del(`/${path}/${id}`), onSuccess: invalidate });
  return { list, save, remove };
}
