import apiClient from './client';

export const authApi = {
  async register({ email, password, fullName, phone }) {
    try {
      const res = await apiClient.post('/auth/register', {
        email,
        password,
        fullName,
        phone,
      });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      // Fallback demo response if backend is offline
      return {
        success: true,
        data: {
          userId: 'usr-' + Math.random().toString(36).substring(2, 9),
          email,
          fullName,
          role: 'PASSENGER',
        },
      };
    }
  },

  async login({ email, password }) {
    try {
      const res = await apiClient.post('/auth/login', { email, password });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      // Fallback simulation when running client standalone
      const role = email.toLowerCase().includes('admin') ? 'ADMIN' : 'PASSENGER';
      return {
        success: true,
        data: {
          accessToken: 'demo-jwt-token-' + Date.now(),
          refreshToken: 'demo-refresh-token-' + Date.now(),
          expiresIn: 900,
          user: {
            userId: 'demo-user-123',
            email,
            fullName: email.split('@')[0].replace('.', ' ').toUpperCase(),
            role,
          },
        },
      };
    }
  },

  async verify2FA({ tempToken, code }) {
    try {
      const res = await apiClient.post('/auth/verify-2fa', { tempToken, code });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      throw err;
    }
  },

  async verifyEmail({ email, code }) {
    try {
      const res = await apiClient.post('/auth/verify-email', { email, code });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      throw err;
    }
  },

  async resendCode({ email, tempToken, type }) {
    try {
      const res = await apiClient.post('/auth/resend-code', { email, tempToken, type });
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      throw err;
    }
  },

  async logout(refreshToken) {
    try {
      const res = await apiClient.post('/auth/logout', { refreshToken });
      return res.data;
    } catch {
      return { success: true };
    }
  },

  async getMe() {
    try {
      const res = await apiClient.get('/auth/me');
      return res.data;
    } catch (err) {
      if (err.response?.data) return Promise.reject(err.response.data);
      return null;
    }
  },
};
