import { create } from 'zustand';

export const useAuthStore = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('aeroscale_user') || 'null'),
  accessToken: localStorage.getItem('aeroscale_access_token') || null,
  refreshToken: localStorage.getItem('aeroscale_refresh_token') || null,
  isInitialized: false,

  isAuthenticated: () => {
    const state = get();
    return !!state.user && !!state.accessToken;
  },

  isAdmin: () => {
    const state = get();
    return state.user?.role === 'ADMIN';
  },

  setAuth: ({ user, accessToken, refreshToken }) => {
    if (user) {
      localStorage.setItem('aeroscale_user', JSON.stringify(user));
    }
    if (accessToken) {
      localStorage.setItem('aeroscale_access_token', accessToken);
    }
    if (refreshToken) {
      localStorage.setItem('aeroscale_refresh_token', refreshToken);
    }
    set({
      user: user !== undefined ? user : get().user,
      accessToken: accessToken !== undefined ? accessToken : get().accessToken,
      refreshToken: refreshToken !== undefined ? refreshToken : get().refreshToken,
      isInitialized: true,
    });
  },

  updateTokens: ({ accessToken, refreshToken }) => {
    if (accessToken) {
      localStorage.setItem('aeroscale_access_token', accessToken);
    }
    if (refreshToken) {
      localStorage.setItem('aeroscale_refresh_token', refreshToken);
    }
    set({
      accessToken: accessToken || get().accessToken,
      refreshToken: refreshToken || get().refreshToken,
    });
  },

  logout: () => {
    localStorage.removeItem('aeroscale_user');
    localStorage.removeItem('aeroscale_access_token');
    localStorage.removeItem('aeroscale_refresh_token');
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      isInitialized: true,
    });
  },

  setInitialized: () => set({ isInitialized: true }),
}));
