import { useApi } from './useApi';
import { api } from '../api';

// Polls every 15s so queued/publishing jobs flip to published/failed live.
export function usePublishJobs(filters) {
  const { status } = filters || {};
  return useApi(
    () => api.getPublishJobs({ status }),
    [status],
    { pollMs: 15000 }
  );
}
