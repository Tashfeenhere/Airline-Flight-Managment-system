const mongoose = require('mongoose');
const { SEAT_STATUS } = require('../config/constants');

const seatSchema = new mongoose.Schema(
  {
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
    status: {
      type: String,
      enum: {
        values: Object.values(SEAT_STATUS),
        message: 'Invalid seat status: {VALUE}'
      },
      default: SEAT_STATUS.AVAILABLE,
      index: true
    },
    version: {
      type: Number,
      required: true,
      default: 0
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
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

// Crucial constraint: A flight can never have duplicate seat numbers
seatSchema.index({ flightId: 1, seatNumber: 1 }, { unique: true });

// Compound index for querying seats by status on a flight
seatSchema.index({ flightId: 1, status: 1 });

const Seat = mongoose.model('Seat', seatSchema);

module.exports = Seat;
