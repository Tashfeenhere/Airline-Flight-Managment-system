export const MOCK_FLIGHTS = [
  {
    flightId: '8f7d9a10-4c32-4b35-86b1-098765432101',
    flightNumber: 'PK-701',
    airlineCode: 'PIA',
    origin: 'ISB',
    destination: 'LHR',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T06:30:00Z',
    arrivalTime: '2026-11-02T14:45:00Z',
    aircraftType: 'Boeing 777-300ER',
    basePrice: 650,
    currency: 'USD',
    status: 'SCHEDULED',
    lowestPrice: 650,
    totalPrice: 650,
    seatsSufficient: true,
    cabins: [
      { cabin: 'ECONOMY', capacity: 280, available: 42, held: 3, price: 650, currency: 'USD', version: 14 },
      { cabin: 'PREMIUM_ECONOMY', capacity: 36, available: 8, held: 1, price: 980, currency: 'USD', version: 6 },
      { cabin: 'BUSINESS', capacity: 28, available: 5, held: 0, price: 1850, currency: 'USD', version: 3 },
      { cabin: 'FIRST', capacity: 8, available: 2, held: 0, price: 3400, currency: 'USD', version: 1 },
    ],
  },
  {
    flightId: '9a8b7c6d-5e4f-4a3b-9c8d-123456789002',
    flightNumber: 'BA-260',
    airlineCode: 'BAW',
    origin: 'ISB',
    destination: 'LHR',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T11:15:00Z',
    arrivalTime: '2026-11-02T19:25:00Z',
    aircraftType: 'Boeing 787-9 Dreamliner',
    basePrice: 720,
    currency: 'USD',
    status: 'SCHEDULED',
    lowestPrice: 720,
    totalPrice: 720,
    seatsSufficient: true,
    cabins: [
      { cabin: 'ECONOMY', capacity: 216, available: 68, held: 2, price: 720, currency: 'USD', version: 21 },
      { cabin: 'PREMIUM_ECONOMY', capacity: 39, available: 12, held: 0, price: 1100, currency: 'USD', version: 8 },
      { cabin: 'BUSINESS', capacity: 42, available: 10, held: 1, price: 2100, currency: 'USD', version: 5 },
    ],
  },
  {
    flightId: '1b2c3d4e-5f6a-4b7c-8d9e-012345678903',
    flightNumber: 'EK-613',
    airlineCode: 'UAE',
    origin: 'ISB',
    destination: 'DXB',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T03:20:00Z',
    arrivalTime: '2026-11-02T06:50:00Z',
    aircraftType: 'Airbus A380-800',
    basePrice: 380,
    currency: 'USD',
    status: 'SCHEDULED',
    lowestPrice: 380,
    totalPrice: 380,
    seatsSufficient: true,
    cabins: [
      { cabin: 'ECONOMY', capacity: 427, available: 115, held: 4, price: 380, currency: 'USD', version: 33 },
      { cabin: 'BUSINESS', capacity: 76, available: 18, held: 2, price: 1250, currency: 'USD', version: 12 },
      { cabin: 'FIRST', capacity: 14, available: 4, held: 0, price: 2850, currency: 'USD', version: 4 },
    ],
  },
  {
    flightId: '3c4d5e6f-7a8b-4c9d-0e1f-234567890104',
    flightNumber: 'QR-632',
    airlineCode: 'QTR',
    origin: 'ISB',
    destination: 'DOH',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T08:45:00Z',
    arrivalTime: '2026-11-02T11:40:00Z',
    aircraftType: 'Boeing 777-200LR',
    basePrice: 410,
    currency: 'USD',
    status: 'SCHEDULED',
    lowestPrice: 410,
    totalPrice: 410,
    seatsSufficient: true,
    cabins: [
      { cabin: 'ECONOMY', capacity: 230, available: 35, held: 1, price: 410, currency: 'USD', version: 19 },
      { cabin: 'BUSINESS', capacity: 42, available: 8, held: 0, price: 1400, currency: 'USD', version: 7 },
    ],
  },
  {
    flightId: '5e6f7a8b-9c0d-4e1f-2a3b-456789012305',
    flightNumber: 'AA-100',
    airlineCode: 'AAL',
    origin: 'JFK',
    destination: 'LHR',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T18:30:00Z',
    arrivalTime: '2026-11-03T06:20:00Z',
    aircraftType: 'Boeing 777-300ER',
    basePrice: 850,
    currency: 'USD',
    status: 'SCHEDULED',
    lowestPrice: 850,
    totalPrice: 850,
    seatsSufficient: true,
    cabins: [
      { cabin: 'ECONOMY', capacity: 216, available: 52, held: 3, price: 850, currency: 'USD', version: 15 },
      { cabin: 'BUSINESS', capacity: 52, available: 11, held: 1, price: 2900, currency: 'USD', version: 9 },
      { cabin: 'FIRST', capacity: 8, available: 1, held: 0, price: 5200, currency: 'USD', version: 2 },
    ],
  },
];

export function generateMockSeatMap(flightId, cabin = 'ECONOMY') {
  const flight = MOCK_FLIGHTS.find((f) => f.flightId === flightId) || MOCK_FLIGHTS[0];
  let columns = ['A', 'B', 'C', '_', 'D', 'E', 'F'];
  let rowCount = 20;
  let startRow = 15;

  if (cabin === 'BUSINESS') {
    columns = ['A', '_', 'D', 'G', '_', 'K'];
    rowCount = 7;
    startRow = 5;
  } else if (cabin === 'FIRST') {
    columns = ['A', '_', 'E', '_', 'K'];
    rowCount = 3;
    startRow = 1;
  } else if (cabin === 'PREMIUM_ECONOMY') {
    columns = ['A', 'B', '_', 'D', 'E', 'F', '_', 'J', 'K'];
    rowCount = 5;
    startRow = 10;
  }

  const rows = [];
  const seats = [];

  for (let r = 0; r < rowCount; r++) {
    const rowNum = startRow + r;
    rows.push(rowNum);
    const isExitRow = rowNum === 18 || rowNum === 25;

    columns.forEach((col, colIdx) => {
      if (col === '_') return;
      const seatNumber = `${rowNum}${col}`;
      // Randomly mark ~25% seats as booked
      const hash = (seatNumber.charCodeAt(0) * 17 + seatNumber.charCodeAt(1) * 31 + r * 7) % 100;
      const isBooked = hash < 30;

      let position = 'MIDDLE';
      if (colIdx === 0 || colIdx === columns.length - 1) position = 'WINDOW';
      else if (columns[colIdx - 1] === '_' || columns[colIdx + 1] === '_') position = 'AISLE';

      seats.push({
        seatNumber,
        status: isBooked ? 'BOOKED' : 'AVAILABLE',
        cabin,
        isExitRow,
        bookable: !isBooked,
        position,
      });
    });
  }

  const cabinInfo = flight.cabins?.find((c) => c.cabin === cabin) || {
    capacity: seats.length,
    available: seats.filter((s) => s.status === 'AVAILABLE').length,
    price: flight.basePrice,
    currency: flight.currency,
  };

  return {
    flightId: flight.flightId,
    cabin,
    aircraftType: flight.aircraftType,
    columns,
    rows,
    seats,
    availableSeats: seats.filter((s) => s.status === 'AVAILABLE').length,
    totalSeats: seats.length,
    price: cabinInfo.price || flight.basePrice,
    currency: flight.currency,
    note: 'Autorun Citus Projection & SVG Seat Map',
  };
}

export const MOCK_BOOKINGS = [
  {
    bookingId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    bookingReference: 'BK-7F9A12K4QW',
    flightId: '8f7d9a10-4c32-4b35-86b1-098765432101',
    flightNumber: 'PK-701',
    airlineCode: 'PIA',
    origin: 'ISB',
    destination: 'LHR',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T06:30:00Z',
    arrivalTime: '2026-11-02T14:45:00Z',
    aircraftType: 'Boeing 777-300ER',
    cabin: 'ECONOMY',
    seatNumber: '16A',
    passengerName: 'Ada Lovelace',
    passengerRef: 'PASS-9001',
    price: 650,
    currency: 'USD',
    status: 'CONFIRMED',
    createdAt: '2026-10-20T10:14:00Z',
  },
  {
    bookingId: 'a12bc34d-56ef-7890-abcd-ef1234567890',
    bookingReference: 'BK-99X21B008A',
    flightId: '1b2c3d4e-5f6a-4b7c-8d9e-012345678903',
    flightNumber: 'EK-613',
    airlineCode: 'UAE',
    origin: 'ISB',
    destination: 'DXB',
    departureDate: '2026-11-02',
    departureTime: '2026-11-02T03:20:00Z',
    arrivalTime: '2026-11-02T06:50:00Z',
    aircraftType: 'Airbus A380-800',
    cabin: 'BUSINESS',
    seatNumber: '7K',
    passengerName: 'Ada Lovelace',
    passengerRef: 'PASS-9001',
    price: 1250,
    currency: 'USD',
    status: 'CONFIRMED',
    createdAt: '2026-10-18T14:22:00Z',
  },
];

export const MOCK_ADMIN_TOPOLOGY = {
  coordinator: {
    nodeId: 'citus-coordinator',
    host: 'coordinator.internal',
    port: 5432,
    role: 'primary',
    citusVersion: 'Citus 12.1.2 on PostgreSQL 16.2',
  },
  workers: [
    { nodeId: 'worker-1', host: 'worker-1.internal', port: 5432, shardCount: 32, active: true, load: '14%' },
    { nodeId: 'worker-2', host: 'worker-2.internal', port: 5432, shardCount: 32, active: true, load: '18%' },
    { nodeId: 'worker-3', host: 'worker-3.internal', port: 5432, shardCount: 32, active: true, load: '11%' },
    { nodeId: 'worker-4', host: 'worker-4.internal', port: 5432, shardCount: 32, active: true, load: '16%' },
  ],
  totalShards: 128,
  replicationFactor: 1,
  partitionStrategy: 'MONTHLY_RANGE_HASH',
};

export const MOCK_OUTBOX_STATS = {
  pending: 3,
  published: 14890,
  failed: 0,
  total: 14893,
  maxAttempts: 1,
  oldestEventAgeMs: 420,
  oldestEventTimestamp: new Date(Date.now() - 420).toISOString(),
  eventBreakdown: [
    { eventType: 'BOOKING_RESERVED', count: 5210 },
    { eventType: 'BOOKING_CONFIRMED', count: 4890 },
    { eventType: 'PAYMENT_CAPTURED', count: 4890 },
    { eventType: 'BOOKING_CANCELLED', count: 120 },
    { eventType: 'INVENTORY_RELEASED', count: 120 },
  ],
  hourlyVolume: [
    { time: '08:00', published: 640, pending: 2 },
    { time: '09:00', published: 920, pending: 4 },
    { time: '10:00', published: 1350, pending: 1 },
    { time: '11:00', published: 1840, pending: 5 },
    { time: '12:00', published: 2100, pending: 3 },
    { time: '13:00', published: 1980, pending: 2 },
    { time: '14:00', published: 2240, pending: 3 },
  ],
};
