export const CABINS = ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'];

export const CABIN_DETAILS = {
  ECONOMY: {
    label: 'Economy',
    code: 'ECONOMY',
    description: 'Ergonomic seating, standard baggage, complimentary refreshments',
  },
  PREMIUM_ECONOMY: {
    label: 'Premium Economy',
    code: 'PREMIUM_ECONOMY',
    description: 'Extra legroom, priority boarding, enhanced catering',
  },
  BUSINESS: {
    label: 'Business Class',
    code: 'BUSINESS',
    description: 'Lie-flat bed, lounge access, premium dining, priority baggage',
  },
  FIRST: {
    label: 'First Class',
    code: 'FIRST',
    description: 'Private suite, à la carte caviar & champagne, chauffeur service',
  },
};

export const BOOKING_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

export const FLIGHT_STATUS = {
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  DEPARTED: 'DEPARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

export const USER_ROLES = {
  PASSENGER: 'PASSENGER',
  AGENT: 'AGENT',
  ADMIN: 'ADMIN',
};

export const AIRPORTS = [
  { code: 'ISB', city: 'Islamabad', name: 'Islamabad International Airport', country: 'Pakistan' },
  { code: 'LHR', city: 'London', name: 'Heathrow Airport', country: 'United Kingdom' },
  { code: 'JFK', city: 'New York', name: 'John F. Kennedy International', country: 'United States' },
  { code: 'DXB', city: 'Dubai', name: 'Dubai International Airport', country: 'United Arab Emirates' },
  { code: 'DOH', city: 'Doha', name: 'Hamad International Airport', country: 'Qatar' },
  { code: 'SIN', city: 'Singapore', name: 'Changi Airport', country: 'Singapore' },
  { code: 'FRA', city: 'Frankfurt', name: 'Frankfurt Airport', country: 'Germany' },
  { code: 'CDG', city: 'Paris', name: 'Charles de Gaulle Airport', country: 'France' },
  { code: 'HND', city: 'Tokyo', name: 'Haneda Airport', country: 'Japan' },
  { code: 'ORD', city: 'Chicago', name: 'O\'Hare International Airport', country: 'United States' },
  { code: 'LAX', city: 'Los Angeles', name: 'Los Angeles International Airport', country: 'United States' },
  { code: 'SYD', city: 'Sydney', name: 'Kingsford Smith Airport', country: 'Australia' },
  { code: 'IST', city: 'Istanbul', name: 'Istanbul Airport', country: 'Turkey' },
  { code: 'KHI', city: 'Karachi', name: 'Jinnah International Airport', country: 'Pakistan' },
  { code: 'LHE', city: 'Lahore', name: 'Allama Iqbal International', country: 'Pakistan' },
  { code: 'AMS', city: 'Amsterdam', name: 'Schiphol Airport', country: 'Netherlands' },
  { code: 'YYZ', city: 'Toronto', name: 'Pearson International Airport', country: 'Canada' },
];
