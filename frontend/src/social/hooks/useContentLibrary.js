import { useApi } from './useApi';
import { api } from '../api';

export function useContentLibrary(filters) {
  const { platform, topic, format, dateFilter, account, sortBy, search, page, limit } = filters || {};
  return useApi(
    () => api.getContentLibrary({ platform, topic, format, dateFilter, account, sortBy, search, page, limit }),
    [platform, topic, format, dateFilter, account, sortBy, search, page, limit]
  );
}
