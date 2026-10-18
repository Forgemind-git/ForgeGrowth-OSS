import { useApi } from './useApi';
import { api } from '../api';

export function useInsights() {
  return useApi(() => api.getInsights(), []);
}
