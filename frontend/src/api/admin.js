import apiClient from './client';
import { MOCK_ADMIN_TOPOLOGY, MOCK_OUTBOX_STATS, MOCK_FLIGHTS } from './mockData';

export const adminApi = {
  async getTopology() {
    try {
      const res = await apiClient.get('/admin/topology');
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return { success: true, data: MOCK_ADMIN_TOPOLOGY };
    }
  },

  async getOutboxStats() {
    try {
      const res = await apiClient.get('/admin/outbox/stats');
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return { success: true, data: MOCK_OUTBOX_STATS };
    }
  },

  async upsertFlight(flightData) {
    try {
      const res = await apiClient.post('/admin/flights', flightData);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return {
        success: true,
        data: {
          ...flightData,
          flightId: flightData.flightId || 'flt-' + Math.random().toString(36).substring(2, 9),
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },

  async maintainPartitions(params) {
    try {
      const res = await apiClient.post('/admin/partitions/maintain', params);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return {
        success: true,
        data: {
          dryRun: params.dryRun || false,
          partitionsCreated: 3,
          partitionsDropped: 0,
          horizon: '2027-11-01',
          retentionCutoff: '2024-11-01',
          mode: params.mode || 'drop',
        },
      };
    }
  },

  async reproject(params) {
    try {
      const res = await apiClient.post('/admin/projections/reproject', params);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return {
        success: true,
        data: {
          projected: 48,
          written: 48,
          skipped: 0,
          batches: 4,
          elapsedMs: 230,
          lagMs: 0,
        },
      };
    }
  },

  async auditInventory(params) {
    try {
      const res = await apiClient.post('/admin/inventory/audit', params);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return {
        success: true,
        data: {
          checked: 34,
          oversoldCount: 0,
          violations: [],
          inspectedFlights: MOCK_FLIGHTS.map((f) => ({
            flightId: f.flightId,
            flightNumber: f.flightNumber,
            cabin: 'ECONOMY',
            capacity: 280,
            booked: 238,
            available: 42,
            held: 0,
            delta: 0,
            status: 'HEALTHY',
          })),
        },
      };
    }
  },

  async getHealth() {
    try {
      const res = await apiClient.get('/health');
      return res.data;
    } catch {
      return {
        success: true,
        data: {
          status: 'ok',
          uptime: 86400,
          version: '2.0.0',
          citus: 'connected',
          redis: 'connected',
        },
      };
    }
  },
};
