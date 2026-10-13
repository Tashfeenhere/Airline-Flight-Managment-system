const {
  FLIGHT_STATUS,
  SEAT_STATUS,
  BOOKING_STATUS,
  ERROR_CODES,
  HEADERS
} = require('../config/constants');

const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Distributed Airline Seat Inventory API',
    version: '1.0.0',
    description: `
## Architecture Overview
Production-grade distributed airline seat reservation system designed to guarantee strict data consistency and zero double-bookings under extreme concurrent load across distributed nodes.

### Key Capabilities
- **Optimistic Concurrency Control (OCC)**: Seat document version check prevents race conditions and phantom bookings.
- **MongoDB Multi-Document ACID Transactions**: Guarantees atomic seat state transition, flight inventory adjustment, and booking record insertion with automatic rollback on mid-operation failure.
- **Distributed Idempotency**: Guarantees at-most-once execution for requests using an \`Idempotency-Key\`.
- **Automatic Transient Retry**: Resilient exponential backoff with jitter on transient MongoDB write conflicts.
- **Distributed Multi-Node Tracking**: Request logging and headers tracking which cluster node (\`NODE_A\`, \`NODE_B\`, \`NODE_C\`) processed each transaction.
    `,
    contact: {
      name: 'Distributed Systems Engineering'
    },
    license: {
      name: 'ISC'
    }
  },
  servers: [
    {
      url: '/',
      description: 'Current Node Instance'
    },
    {
      url: 'http://localhost:3000',
      description: 'Local Default Node (Port 3000)'
    },
    {
      url: 'http://localhost:3001',
      description: 'Distributed Cluster Node A (Port 3001)'
    },
    {
      url: 'http://localhost:3002',
      description: 'Distributed Cluster Node B (Port 3002)'
    },
    {
      url: 'http://localhost:3003',
      description: 'Distributed Cluster Node C (Port 3003)'
    }
  ],
  tags: [
    {
      name: 'System',
      description: 'System-level information and root status'
    },
    {
      name: 'Health',
      description: 'Liveness, readiness, and database connectivity monitoring'
    },
    {
      name: 'Flights',
      description: 'Flight catalog management and seat availability inspection'
    },
    {
      name: 'Bookings',
      description: 'Seat reservations, OCC transactional booking, and cancellations'
    }
  ],
  paths: {
    '/': {
      get: {
        tags: ['System'],
        summary: 'Root Node Status',
        description: 'Returns metadata about the running node instance and links to documentation.',
        responses: {
          200: {
            description: 'Node status and documentation links',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SystemInfoResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Cluster Node Health Check',
        description: 'Returns the health status of the running backend node instance and MongoDB replica set connectivity.',
        responses: {
          200: {
            description: 'Node is fully operational and connected to MongoDB',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse'
                }
              }
            }
          },
          503: {
            description: 'Node is degraded or disconnected from MongoDB',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/flights': {
      get: {
        tags: ['Flights'],
        summary: 'Search & List Flights',
        description: 'Retrieves a list of scheduled flights filtered by flight number, origin, destination, price, availability, or status.',
        parameters: [
          {
            name: 'flightNumber',
            in: 'query',
            description: 'Filter by exact flight number (e.g. PK123)',
            required: false,
            schema: { type: 'string', example: 'PK123' }
          },
          {
            name: 'origin',
            in: 'query',
            description: 'Filter by origin airport code (IATA)',
            required: false,
            schema: { type: 'string', example: 'ISB' }
          },
          {
            name: 'destination',
            in: 'query',
            description: 'Filter by destination airport code (IATA)',
            required: false,
            schema: { type: 'string', example: 'LHR' }
          },
          {
            name: 'maxPrice',
            in: 'query',
            description: 'Filter flights with price less than or equal to this value',
            required: false,
            schema: { type: 'number', minimum: 0, example: 900 }
          },
          {
            name: 'minAvailableSeats',
            in: 'query',
            description: 'Filter flights with at least this many available seats',
            required: false,
            schema: { type: 'integer', minimum: 0, example: 1 }
          },
          {
            name: 'hasAvailableSeats',
            in: 'query',
            description: 'Filter only flights that currently have at least 1 seat available',
            required: false,
            schema: { type: 'string', enum: ['true', 'false'], example: 'true' }
          },
          {
            name: 'status',
            in: 'query',
            description: 'Filter by flight operational status',
            required: false,
            schema: {
              type: 'string',
              enum: Object.values(FLIGHT_STATUS),
              example: FLIGHT_STATUS.SCHEDULED
            }
          }
        ],
        responses: {
          200: {
            description: 'List of matching flights',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/FlightListResponse'
                }
              }
            }
          },
          400: {
            description: 'Invalid filter parameter provided',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/flights/{flightId}': {
      get: {
        tags: ['Flights'],
        summary: 'Get Flight Details',
        description: 'Retrieves comprehensive flight information for a given flight ID.',
        parameters: [
          {
            $ref: '#/components/parameters/FlightIdParam'
          }
        ],
        responses: {
          200: {
            description: 'Flight details retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/FlightDetailResponse'
                }
              }
            }
          },
          400: {
            description: 'Invalid flight ID format',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Flight not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/flights/{flightId}/seats': {
      get: {
        tags: ['Flights'],
        summary: 'Get Flight Seat Map',
        description: 'Retrieves all seats for a given flight, including their OCC version number and availability status.',
        parameters: [
          {
            $ref: '#/components/parameters/FlightIdParam'
          },
          {
            name: 'status',
            in: 'query',
            description: 'Filter seats by status (AVAILABLE or BOOKED)',
            required: false,
            schema: {
              type: 'string',
              enum: Object.values(SEAT_STATUS),
              example: SEAT_STATUS.AVAILABLE
            }
          }
        ],
        responses: {
          200: {
            description: 'List of seats on the flight',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/SeatListResponse'
                }
              }
            }
          },
          400: {
            description: 'Invalid flight ID or status parameter',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Flight not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/bookings': {
      post: {
        tags: ['Bookings'],
        summary: 'Reserve a Flight Seat',
        description: `
Executes an atomic seat reservation using Optimistic Concurrency Control (OCC) and MongoDB multi-document transactions.

- Checks that seat is \`AVAILABLE\` and captures \`version\`
- Optimistically transitions seat to \`BOOKED\` while matching expected \`version\`
- Decrements flight \`availableSeats\`
- Inserts confirmed \`Booking\` document
- Supports idempotency via \`idempotencyKey\` (in body or \`Idempotency-Key\` / \`x-idempotency-key\` headers)
- Replaying an identical \`idempotencyKey\` returns HTTP 200 with \`isIdempotentReplay: true\`
        `,
        parameters: [
          {
            $ref: '#/components/parameters/IdempotencyKeyHeader'
          },
          {
            $ref: '#/components/parameters/NodeIdHeader'
          }
        ],
        requestBody: {
          required: true,
          description: 'Seat booking request details',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateBookingRequest'
              }
            }
          }
        },
        responses: {
          201: {
            description: 'Booking successfully confirmed',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BookingResponse'
                }
              }
            }
          },
          200: {
            description: 'Idempotent replay: original booking returned without re-executing reservation',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BookingResponse'
                }
              }
            }
          },
          400: {
            description: 'Invalid request payload or malformed identifiers',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Flight or requested seat does not exist',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          409: {
            description: 'Concurrency Conflict: Seat already booked, OCC version mismatch, or inventory depleted',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          503: {
            description: 'Transient transaction write conflict exhausted max retries',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/bookings/{bookingId}': {
      get: {
        tags: ['Bookings'],
        summary: 'Get Booking Details',
        description: 'Retrieves booking record details by either MongoDB ObjectId or alphanumeric booking reference (e.g. BK-7F9A12).',
        parameters: [
          {
            $ref: '#/components/parameters/BookingIdentifierParam'
          }
        ],
        responses: {
          200: {
            description: 'Booking details retrieved',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BookingDetailResponse'
                }
              }
            }
          },
          400: {
            description: 'Invalid booking identifier parameter',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Booking not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      },
      delete: {
        tags: ['Bookings'],
        summary: 'Cancel Booking (RESTful DELETE)',
        description: 'Cancels the booking, releases the seat back to AVAILABLE, and increments available flight inventory.',
        parameters: [
          {
            $ref: '#/components/parameters/BookingIdentifierParam'
          },
          {
            $ref: '#/components/parameters/NodeIdHeader'
          }
        ],
        responses: {
          200: {
            description: 'Booking cancelled successfully and seat released',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CancelBookingResponse'
                }
              }
            }
          },
          400: {
            description: 'Booking is already cancelled or in an invalid status',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Booking not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    },
    '/api/bookings/{bookingId}/cancel': {
      post: {
        tags: ['Bookings'],
        summary: 'Cancel Booking (POST Action)',
        description: 'Cancels the booking, restores seat to AVAILABLE, and increments flight inventory within an ACID transaction.',
        parameters: [
          {
            $ref: '#/components/parameters/BookingIdentifierParam'
          },
          {
            $ref: '#/components/parameters/NodeIdHeader'
          }
        ],
        responses: {
          200: {
            description: 'Booking cancelled successfully and seat released',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/CancelBookingResponse'
                }
              }
            }
          },
          400: {
            description: 'Booking is already cancelled or invalid status',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          },
          404: {
            description: 'Booking not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse'
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    parameters: {
      FlightIdParam: {
        name: 'flightId',
        in: 'path',
        required: true,
        description: '24-character hexadecimal MongoDB ObjectId of the flight',
        schema: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{24}$',
          example: '65f01234567890abcdef1234'
        }
      },
      BookingIdentifierParam: {
        name: 'bookingId',
        in: 'path',
        required: true,
        description: 'MongoDB ObjectId or booking reference code (e.g. BK-7F9A12)',
        schema: {
          type: 'string',
          example: 'BK-7F9A12'
        }
      },
      IdempotencyKeyHeader: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Unique client idempotency token to avoid duplicate bookings during network retries',
        schema: {
          type: 'string',
          example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
        }
      },
      NodeIdHeader: {
        name: 'X-Node-Id',
        in: 'header',
        required: false,
        description: 'Optional override header to simulate or record the originating node',
        schema: {
          type: 'string',
          example: 'NODE_A'
        }
      }
    },
    schemas: {
      Flight: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '65f01234567890abcdef1234' },
          flightNumber: { type: 'string', example: 'PK123' },
          origin: { type: 'string', example: 'ISB' },
          destination: { type: 'string', example: 'LHR' },
          departureTime: { type: 'string', format: 'date-time', example: '2026-10-01T10:00:00.000Z' },
          arrivalTime: { type: 'string', format: 'date-time', example: '2026-10-01T18:30:00.000Z' },
          totalSeats: { type: 'integer', example: 180 },
          availableSeats: { type: 'integer', example: 179 },
          price: { type: 'number', example: 750 },
          status: {
            type: 'string',
            enum: Object.values(FLIGHT_STATUS),
            example: FLIGHT_STATUS.SCHEDULED
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Seat: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '65f01234567890abcdef5678' },
          flightId: { type: 'string', example: '65f01234567890abcdef1234' },
          seatNumber: { type: 'string', example: '12A' },
          status: {
            type: 'string',
            enum: Object.values(SEAT_STATUS),
            example: SEAT_STATUS.AVAILABLE
          },
          version: {
            type: 'integer',
            description: 'OCC version counter, incremented atomically on every state transition',
            example: 0
          },
          bookingId: {
            type: 'string',
            nullable: true,
            example: null
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      Booking: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '65f01234567890abcdef9999' },
          bookingReference: { type: 'string', example: 'BK-7F9A12' },
          flightId: { type: 'string', example: '65f01234567890abcdef1234' },
          seatNumber: { type: 'string', example: '12A' },
          passengerId: { type: 'string', example: 'PASS-1001' },
          nodeId: { type: 'string', example: 'NODE_A' },
          transactionId: { type: 'string', format: 'uuid', example: 'e3b0c442-98fc-1c14-9afb-4c7c58d20000' },
          status: {
            type: 'string',
            enum: Object.values(BOOKING_STATUS),
            example: BOOKING_STATUS.CONFIRMED
          },
          idempotencyKey: { type: 'string', nullable: true, example: 'req-token-554' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      CreateBookingRequest: {
        type: 'object',
        required: ['flightId', 'seatNumber', 'passengerId'],
        properties: {
          flightId: {
            type: 'string',
            description: 'Valid 24-character hexadecimal MongoDB ObjectId of the flight',
            example: '65f01234567890abcdef1234'
          },
          seatNumber: {
            type: 'string',
            description: 'Alphanumeric seat identifier',
            example: '12A'
          },
          passengerId: {
            type: 'string',
            description: 'Unique passenger or customer identifier',
            example: 'PASS-1001'
          },
          idempotencyKey: {
            type: 'string',
            description: 'Optional client-provided idempotency key (can also be provided in Idempotency-Key header)',
            example: 'txn-checkout-user-12345'
          }
        }
      },
      SystemInfoResponse: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Distributed Airline Seat Inventory System' },
          nodeId: { type: 'string', example: 'NODE_LOCAL' },
          status: { type: 'string', example: 'ONLINE' },
          docs: { type: 'string', example: '/api-docs' }
        }
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'UP' },
          nodeId: { type: 'string', example: 'NODE_LOCAL' },
          port: { type: 'integer', example: 3000 },
          database: { type: 'string', example: 'CONNECTED' },
          timestamp: { type: 'string', format: 'date-time' },
          uptime: { type: 'number', example: 42.125 }
        }
      },
      FlightListResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          count: { type: 'integer', example: 1 },
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Flight' }
          }
        }
      },
      FlightDetailResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/Flight' }
        }
      },
      SeatListResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          count: { type: 'integer', example: 6 },
          data: {
            type: 'array',
            items: { $ref: '#/components/schemas/Seat' }
          }
        }
      },
      BookingResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          isIdempotentReplay: { type: 'boolean', example: false },
          data: { $ref: '#/components/schemas/Booking' }
        }
      },
      BookingDetailResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/Booking' }
        }
      },
      CancelBookingResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Booking cancelled successfully and seat released' },
          data: { $ref: '#/components/schemas/Booking' }
        }
      },
      ErrorDetail: {
        type: 'object',
        properties: {
          field: { type: 'string', example: 'flightId' },
          message: { type: 'string', example: 'flightId is required' }
        }
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                enum: Object.values(ERROR_CODES),
                example: ERROR_CODES.SEAT_UNAVAILABLE
              },
              message: { type: 'string', example: 'Seat 12A is already booked (status: BOOKED)' },
              details: {
                type: 'array',
                items: { $ref: '#/components/schemas/ErrorDetail' }
              }
            }
          },
          nodeId: { type: 'string', example: 'NODE_LOCAL' },
          timestamp: { type: 'string', format: 'date-time' }
        }
      }
    }
  }
};

module.exports = swaggerSpec;
