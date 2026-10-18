import { useApi } from './useApi';
import { api } from '../api';

export function useOverview(period) {
  return useApi(() => api.getOverview(period), [period], { pollMs: 60000 });
}
