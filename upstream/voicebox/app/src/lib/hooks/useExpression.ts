import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { useServerStore } from '@/stores/serverStore';

export function useExpressionCapabilities() {
  const base = useServerStore((state) => state.serverUrl);
  return useQuery({
    queryKey: ['expression-capabilities', base],
    queryFn: () => apiClient.getExpressionCapabilities(),
    staleTime: 10000,
    refetchInterval: 15000,
    retry: 1,
  });
}
