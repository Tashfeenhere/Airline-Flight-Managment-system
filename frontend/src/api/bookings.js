import apiClient from './client';
import { MOCK_BOOKINGS, MOCK_FLIGHTS } from './mockData';

let localBookings = [...MOCK_BOOKINGS];

export const bookingsApi = {
  async createBooking(bookingData, idempotencyKey) {
    try {
      const headers = {};
      if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
      }
      const res = await apiClient.post('/bookings', bookingData, { headers });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return Promise.reject(err);
    }
  },

  async getBooking(bookingId) {
    try {
      const res = await apiClient.get(`/bookings/${bookingId}`);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      const booking = localBookings.find((b) => b.bookingId === bookingId) || localBookings[0];
      return { success: true, data: booking };
    }
  },

  async getByReference(reference) {
    try {
      const res = await apiClient.get(`/bookings/reference/${reference}`);
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      const booking = localBookings.find(
        (b) => b.bookingReference.toLowerCase() === reference.toLowerCase()
      ) || localBookings[0];
      return { success: true, data: booking };
    }
  },

  async cancelBooking(bookingId, reason) {
    try {
      const res = await apiClient.post(`/bookings/${bookingId}/cancel`, { reason });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      const idx = localBookings.findIndex((b) => b.bookingId === bookingId);
      if (idx !== -1) {
        localBookings[idx] = { ...localBookings[idx], status: 'CANCELLED' };
        return { success: true, data: localBookings[idx] };
      }
      return { success: true, data: { status: 'CANCELLED' } };
    }
  },

  async listMyBookings(params = {}) {
    try {
      const res = await apiClient.get('/users/me/bookings', { params });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      let list = [...localBookings];
      if (params.status && params.status !== 'ALL') {
        list = list.filter((b) => b.status === params.status);
      }
      return {
        success: true,
        data: {
          bookings: list,
          total: list.length,
          limit: params.limit || 20,
          offset: params.offset || 0,
        },
      };
    }
  },
};
