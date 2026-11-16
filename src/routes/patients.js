const express = require('express');
const { query } = require('../../db');
const { parsePositiveInt } = require('../validation');

const router = express.Router();

// GET /patients/:patient_id/appointment -> the active appointment, or null
router.get('/patients/:patient_id/appointment', async (req, res) => {
  const patientId = parsePositiveInt(req.params.patient_id, 'patient_id');
  const { rows } = await query(
    `SELECT a.appointment_id, a.patient_id, a.slot_id, a.status, a.created_at,
            s.center_id, s.vaccine_type, s.starts_at
       FROM appointments a
       JOIN slots s ON s.slot_id = a.slot_id
      WHERE a.patient_id = $1 AND a.status = 'ACTIVE'`,
    [patientId]
  );
  res.json({ patient_id: patientId, appointment: rows[0] ?? null });
});

module.exports = router;
