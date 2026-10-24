const mongoose = require('mongoose');
const { FLIGHT_STATUS } = require('../config/constants');

const flightSchema = new mongoose.Schema(
  {
    flightNumber: {
      type: String,
      required: [true, 'Flight number is required'],
      trim: true,
      uppercase: true,
      index: true
    },
    origin: {
      type: String,
      required: [true, 'Origin airport code is required'],
      trim: true,
      uppercase: true
    },
    destination: {
      type: String,
      required: [true, 'Destination airport code is required'],
      trim: true,
      uppercase: true,
      index: true
    },
    departureTime: {
      type: Date,
      required: [true, 'Departure time is required']
    },
    arrivalTime: {
      type: Date,
      required: [true, 'Arrival time is required']
    },
    totalSeats: {
      type: Number,
      required: [true, 'Total seats count is required'],
      min: [1, 'Total seats must be at least 1']
    },
    availableSeats: {
      type: Number,
      required: [true, 'Available seats count is required'],
      min: [0, 'Available seats cannot be negative']
    },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative']
    },
    status: {
      type: String,
      enum: {
        values: Object.values(FLIGHT_STATUS),
        message: 'Invalid flight status: {VALUE}'
      },
      default: FLIGHT_STATUS.SCHEDULED
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

// Compound index for flight search
flightSchema.index({ origin: 1, destination: 1, departureTime: 1 });

const Flight = mongoose.model('Flight', flightSchema);

module.exports = Flight;
