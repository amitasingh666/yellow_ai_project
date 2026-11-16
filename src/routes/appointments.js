const express = require('express');
const { parsePositiveInt } = require('../validation');
const appointments = require('../services/appointments');

const router = express.Router();

// POST /appointments/:appointment_id/cancel
// Second call is a no-op: 200 with already_cancelled: true.
router.post('/appointments/:appointment_id/cancel', async (req, res) => {
  const appointmentId = parsePositiveInt(req.params.appointment_id, 'appointment_id');
  res.json(await appointments.cancel(appointmentId));
});

// POST /appointments/:appointment_id/reschedule  { new_slot_id }
router.post('/appointments/:appointment_id/reschedule', async (req, res) => {
  const appointmentId = parsePositiveInt(req.params.appointment_id, 'appointment_id');
  const newSlotId = parsePositiveInt(req.body?.new_slot_id, 'new_slot_id');
  res.json(await appointments.reschedule(appointmentId, newSlotId));
});

module.exports = router;
