const express = require('express');
const { withTransaction } = require('../../db');

const router = express.Router();

class CancellationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPositiveInt = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

// DELETE /api/cancellation  { booking_id }
router.delete('/cancellation', async (req, res) => {
  const { booking_id: bookingId } = req.body || {};

  if (!isPositiveInt(bookingId)) {
    return res.status(400).json({ error: 'booking_id must be a positive integer' });
  }

  try {
    const booking = await withTransaction(async (client) => {
      // The booking must belong to a patient and still be active.
      const existing = await client.query(
        `SELECT b.booking_id, b.slot_id
           FROM bookings b
           JOIN patients p ON p.patient_id = b.patient_id
          WHERE b.booking_id = $1 AND b.status = 'BOOKED'
          FOR UPDATE OF b`,
        [bookingId]
      );
      if (existing.rowCount === 0) {
        throw new CancellationError(404, 'Patient does not exist with an active slot');
      }

      const cancelled = await client.query(
        `UPDATE bookings SET status = 'CANCELLED'
          WHERE booking_id = $1
          RETURNING booking_id, patient_id, slot_id, status, created_at`,
        [bookingId]
      );

      // Give the seat back only if the slot is still open.
      await client.query(
        "UPDATE slots SET capacity = capacity + 1 WHERE slot_id = $1 AND status = 'OPEN'",
        [existing.rows[0].slot_id]
      );

      return cancelled.rows[0];
    });

    return res.status(200).json({ message: 'Booking cancelled', booking });
  } catch (error) {
    if (error instanceof CancellationError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Cancellation failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
