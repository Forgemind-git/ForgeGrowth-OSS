import { useApi } from './useApi';
import { api } from '../api';

export function useIntegrations() {
  return useApi(() => api.getIntegrations(), []);
}
