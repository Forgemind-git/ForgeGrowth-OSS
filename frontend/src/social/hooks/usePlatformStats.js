import { useApi } from './useApi';
import { api } from '../api';

export function usePlatformStats(key, period, account) {
  return useApi(() => api.getPlatformStats(key, period, account), [key, period, account]);
}
