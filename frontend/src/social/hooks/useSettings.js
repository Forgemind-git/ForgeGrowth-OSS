import { useApi } from './useApi';
import { api } from '../api';

export function useSettings() {
  return useApi(() => api.getSettings(), []);
}
