const express = require('express');
const { query } = require('../../db');
const { AppError } = require('../errors');
const { parsePositiveInt } = require('../validation');

const router = express.Router();

const SLOT_COLUMNS = `slot_id, center_id, vaccine_type, capacity, booked_count,
                      capacity - booked_count AS remaining, starts_at, status`;

// POST /slots  { center_id, vaccine_type, capacity, starts_at, status? }
router.post('/slots', async (req, res) => {
  const body = req.body || {};
  const centerId = parsePositiveInt(body.center_id, 'center_id');
  const capacity = parsePositiveInt(body.capacity, 'capacity');

  const vaccineType = typeof body.vaccine_type === 'string' ? body.vaccine_type.trim() : '';
  if (!vaccineType || vaccineType.length > 50) {
    throw new AppError(400, 'VALIDATION_ERROR', 'vaccine_type must be a non-empty string (max 50 chars)');
  }

  const startsAt = new Date(body.starts_at);
  if (typeof body.starts_at !== 'string' || Number.isNaN(startsAt.getTime())) {
    throw new AppError(400, 'VALIDATION_ERROR', 'starts_at must be an ISO-8601 timestamp');
  }

  const status = body.status ?? 'OPEN';
  if (!['OPEN', 'CLOSED'].includes(status)) {
    throw new AppError(400, 'VALIDATION_ERROR', "status must be 'OPEN' or 'CLOSED'");
  }

  const { rows } = await query(
    `INSERT INTO slots (center_id, vaccine_type, capacity, starts_at, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SLOT_COLUMNS}`,
    [centerId, vaccineType, capacity, startsAt.toISOString(), status]
  );
  res.status(201).json(rows[0]);
});

// GET /slots -> all slots with live counts
router.get('/slots', async (req, res) => {
  const { rows } = await query(`SELECT ${SLOT_COLUMNS} FROM slots ORDER BY starts_at, slot_id`);
  res.json(rows);
});

// GET /slots/:slot_id -> { booked_count, remaining, capacity, ... }
// booked_count is updated in the same transaction as the appointment row,
// so this read is always exact, never "eventually" correct.
router.get('/slots/:slot_id', async (req, res) => {
  const slotId = parsePositiveInt(req.params.slot_id, 'slot_id');
  const { rows } = await query(`SELECT ${SLOT_COLUMNS} FROM slots WHERE slot_id = $1`, [slotId]);
  if (rows.length === 0) {
    throw new AppError(404, 'SLOT_NOT_FOUND', `Slot ${slotId} does not exist`);
  }
  res.json(rows[0]);
});

// PATCH /slots/:slot_id  { status: 'OPEN' | 'CLOSED' }
// Lets a center close a slot (e.g. staff shortage). The UPDATE needs the slot's
// row lock, so it waits for any booking currently holding it - a booking is
// either fully before the close or sees CLOSED, never in between.
router.patch('/slots/:slot_id', async (req, res) => {
  const slotId = parsePositiveInt(req.params.slot_id, 'slot_id');
  const status = req.body?.status;
  if (!['OPEN', 'CLOSED'].includes(status)) {
    throw new AppError(400, 'VALIDATION_ERROR', "status must be 'OPEN' or 'CLOSED'");
  }
  const { rows } = await query(`UPDATE slots SET status = $2 WHERE slot_id = $1 RETURNING ${SLOT_COLUMNS}`, [
    slotId,
    status,
  ]);
  if (rows.length === 0) {
    throw new AppError(404, 'SLOT_NOT_FOUND', `Slot ${slotId} does not exist`);
  }
  res.json(rows[0]);
});

module.exports = router;
