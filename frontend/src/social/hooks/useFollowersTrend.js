import { useApi } from './useApi';
import { api } from '../api';

// Followers trend for the Overview chart — independent of the KPI period.
// `unit` is 'days' | 'weeks'; `range` is the number of days/weeks to show.
export function useFollowersTrend(key, account, unit, range) {
  return useApi(() => api.getFollowersTrend(key, account, unit, range), [key, account, unit, range]);
}
