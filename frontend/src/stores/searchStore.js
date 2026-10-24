import { create } from 'zustand';

const defaultParams = {
  origin: 'ISB',
  destination: 'LHR',
  departureDate: '2026-11-02',
  cabin: 'ECONOMY',
  passengers: 1,
};

const savedParams = () => {
  try {
    const raw = sessionStorage.getItem('aeroscale_search');
    return raw ? JSON.parse(raw) : defaultParams;
  } catch {
    return defaultParams;
  }
};

export const useSearchStore = create((set) => ({
  searchParams: savedParams(),
  selectedSeat: null,
  selectedCabin: 'ECONOMY',

  setSearchParams: (params) => {
    set((state) => {
      const updated = { ...state.searchParams, ...params };
      try {
        sessionStorage.setItem('aeroscale_search', JSON.stringify(updated));
      } catch (err) {
        console.error('Session storage error:', err);
      }
      return { searchParams: updated };
    });
  },

  setSelectedSeat: (seatNumber) => set({ selectedSeat: seatNumber }),
  setSelectedCabin: (cabin) => set({ selectedCabin: cabin, selectedSeat: null }),
  resetBookingSelection: () => set({ selectedSeat: null }),
}));
