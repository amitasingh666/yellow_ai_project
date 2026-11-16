const express = require('express');
const { AppError } = require('../errors');
const { parsePositiveInt } = require('../validation');
const appointments = require('../services/appointments');

const router = express.Router();

// POST /book   header: Idempotency-Key   body: { slot_id, patient_id }
router.post('/book', async (req, res) => {
  const idempotencyKey = req.get('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 255) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required (max 255 chars)');
  }

  const slotId = parsePositiveInt(req.body?.slot_id, 'slot_id');
  const patientId = parsePositiveInt(req.body?.patient_id, 'patient_id');

  const { statusCode, body } = await appointments.book({ patientId, slotId, idempotencyKey });
  if (body.idempotent_replay) res.set('Idempotent-Replay', 'true');
  res.status(statusCode).json(body);
});

module.exports = router;
