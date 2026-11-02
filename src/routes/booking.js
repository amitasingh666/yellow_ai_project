const express = require('express');
const { withTransaction } = require('../../db');

const router = express.Router();

class BookingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPositiveInt = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

// POST /api/booking  { patient_id, slot_id }
router.post('/booking', async (req, res) => {
  const { patient_id: patientId, slot_id: slotId } = req.body || {};

  if (!isPositiveInt(patientId) || !isPositiveInt(slotId)) {
    return res.status(400).json({ error: 'patient_id and slot_id must be positive integers' });
  }

  try {
    const booking = await withTransaction(async (client) => {
      // Lock the patient row so the same patient can't double-book in parallel requests.
      const patient = await client.query(
        'SELECT patient_id FROM patients WHERE patient_id = $1 FOR UPDATE',
        [patientId]
      );
      if (patient.rowCount === 0) {
        throw new BookingError(404, 'Patient not found');
      }

      // A patient can hold only one active booking.
      const existing = await client.query(
        "SELECT booking_id FROM bookings WHERE patient_id = $1 AND status = 'BOOKED'",
        [patientId]
      );
      if (existing.rowCount > 0) {
        throw new BookingError(409, 'Patient already has a booking');
      }

      // Lock the slot row so concurrent bookings can't exceed its capacity.
      const slotResult = await client.query(
        'SELECT slot_id, capacity, status FROM slots WHERE slot_id = $1 FOR UPDATE',
        [slotId]
      );
      if (slotResult.rowCount === 0) {
        throw new BookingError(404, 'Slot not found');
      }

      const slot = slotResult.rows[0];
      if (slot.status !== 'OPEN') {
        throw new BookingError(409, 'Slot is not open for booking');
      }

      // capacity holds the seats still available in the slot.
      if (slot.capacity <= 0) {
        throw new BookingError(409, 'Slot is fully booked');
      }

      const inserted = await client.query(
        `INSERT INTO bookings (patient_id, slot_id)
         VALUES ($1, $2)
         RETURNING booking_id, patient_id, slot_id, status, created_at`,
        [patientId, slotId]
      );

      await client.query('UPDATE slots SET capacity = capacity - 1 WHERE slot_id = $1', [slotId]);

      return inserted.rows[0];
    });

    return res.status(201).json({ message: 'Booking confirmed', booking });
  } catch (error) {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Booking failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
