const mongoose = require('mongoose');
const { BOOKING_STATUS } = require('../config/constants');

const bookingSchema = new mongoose.Schema(
  {
    bookingReference: {
      type: String,
      required: [true, 'Booking reference is required'],
      unique: true,
      trim: true,
      uppercase: true,
      index: true
    },
    flightId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Flight',
      required: [true, 'Flight ID is required'],
      index: true
    },
    seatNumber: {
      type: String,
      required: [true, 'Seat number is required'],
      trim: true,
      uppercase: true
    },
    passengerId: {
      type: String,
      required: [true, 'Passenger ID is required'],
      trim: true,
      index: true
    },
    nodeId: {
      type: String,
      required: [true, 'Originating Node ID is required'],
      trim: true
    },
    transactionId: {
      type: String,
      required: [true, 'Transaction ID is required'],
      trim: true,
      index: true
    },
    status: {
      type: String,
      enum: {
        values: Object.values(BOOKING_STATUS),
        message: 'Invalid booking status: {VALUE}'
      },
      default: BOOKING_STATUS.CONFIRMED,
      index: true
    },
    idempotencyKey: {
      type: String,
      trim: true,
      default: null
    }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id;
        delete ret.__v;
        return ret;
      }
    }
  }
);

// Primary business invariant at the database level:
// ONE FLIGHT + ONE SEAT = AT MOST ONE CONFIRMED BOOKING
// Partial unique index enforces that multiple bookings can exist ONLY if cancelled,
// but only one can have status = 'CONFIRMED'.
bookingSchema.index(
  { flightId: 1, seatNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { status: BOOKING_STATUS.CONFIRMED }
  }
);

// Idempotency key unique index (sparse so nulls are ignored)
bookingSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    sparse: true
  }
);

const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking;
