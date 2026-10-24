import apiClient from './client';
import { MOCK_FLIGHTS, generateMockSeatMap } from './mockData';

export const flightsApi = {
  async searchFlights(params) {
    try {
      const res = await apiClient.get('/flights/search', { params });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      // Fallback data
      let filtered = [...MOCK_FLIGHTS];
      if (params.origin) {
        filtered = filtered.filter((f) => f.origin.toLowerCase() === params.origin.toLowerCase());
      }
      if (params.destination) {
        filtered = filtered.filter((f) => f.destination.toLowerCase() === params.destination.toLowerCase());
      }
      if (filtered.length === 0) {
        // Return default fixture if exact route has no flights
        filtered = MOCK_FLIGHTS;
      }
      return {
        success: true,
        data: {
          flights: filtered,
          total: filtered.length,
          limit: params.limit || 20,
          offset: params.offset || 0,
          readModelLagMs: 120,
        },
      };
    }
  },

  async getFlight(flightId) {
    try {
      const res = await apiClient.get(`/flights/${flightId}`);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      const flight = MOCK_FLIGHTS.find((f) => f.flightId === flightId) || MOCK_FLIGHTS[0];
      return {
        success: true,
        data: flight,
      };
    }
  },

  async getSeatMap(flightId, cabin) {
    try {
      const res = await apiClient.get(`/flights/${flightId}/seatmap`, {
        params: cabin ? { cabin } : undefined,
      });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return {
        success: true,
        data: generateMockSeatMap(flightId, cabin || 'ECONOMY'),
      };
    }
  },

  async getAvailability(flightId, cabin) {
    try {
      const res = await apiClient.get(`/flights/${flightId}/availability`, {
        params: cabin ? { cabin } : undefined,
      });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      const flight = MOCK_FLIGHTS.find((f) => f.flightId === flightId) || MOCK_FLIGHTS[0];
      return {
        success: true,
        data: {
          flightId,
          departureDate: flight.departureDate,
          status: flight.status,
          departureTime: flight.departureTime,
          authoritative: true,
          versionPinningAvailable: true,
          cabins: flight.cabins,
        },
      };
    }
  },
};
