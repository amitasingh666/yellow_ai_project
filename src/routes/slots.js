const express = require('express');
const { query } = require('../../db');

const router = express.Router();

const isPositiveInt = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

// GET /api/slots/:slot_id  (or /api/slots?slot_id=)  -> details of that slot if it has capacity
// GET /api/slots                                     -> number of slots that still have capacity
router.get(['/slots', '/slots/:slot_id'], async (req, res) => {
  const slotId = req.params.slot_id ?? req.query.slot_id;

  try {
    if (slotId === undefined) {
      const result = await query('SELECT COUNT(*)::int AS count FROM slots WHERE capacity > 0');
      return res.status(200).json(result.rows[0].count);
    }

    if (!isPositiveInt(slotId)) {
      return res.status(400).json({ error: 'slot_id must be a positive integer' });
    }

    const result = await query(
      `SELECT slot_id, center_id, capacity AS capacity_remaining, vaccine_type, status
         FROM slots
        WHERE slot_id = $1`,
      [slotId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    const slot = result.rows[0];
    if (slot.capacity_remaining <= 0) {
      return res.status(409).json({ error: 'No capacity available for this slot' });
    }

    return res.status(200).json(slot);
  } catch (error) {
    console.error('Fetching slots failed:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
