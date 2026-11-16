// All booking / cancel / reschedule logic lives here.
//
// Correctness never depends on anything in this process's memory: every rule
// is enforced inside a single PostgreSQL transaction using row locks, so it
// holds no matter how many app instances share the database.
//
// Lock order (always the same, which rules out deadlocks between our own operations):
//   idempotency key -> patient row -> appointment row -> slot rows (ascending slot_id)

const { withTransaction } = require('../../db');
const { AppError } = require('../errors');

const APPOINTMENT_COLUMNS = 'appointment_id, patient_id, slot_id, status, created_at, cancelled_at';
const CUTOFF = "interval '2 hours'";

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

// Locks the patient's row (creating it on first use). Every operation that
// changes a patient's appointments takes this lock first, so a patient's
// requests run one at a time even when they hit different app instances.
const lockPatient = async (client, patientId) => {
  await client.query(
    'INSERT INTO patients (patient_id) VALUES ($1) ON CONFLICT (patient_id) DO NOTHING',
    [patientId]
  );
  const { rows } = await client.query(
    'SELECT patient_id, active_appointment_id FROM patients WHERE patient_id = $1 FOR UPDATE',
    [patientId]
  );
  return rows[0];
};

// Locks slot rows in ascending slot_id order. While a transaction holds a
// slot's lock, nobody else can book it, cancel from it, or close it.
//
// The cutoff is evaluated with the DATABASE clock: now() is the single
// transaction timestamp, shared by every app instance. A slot is bookable
// only if starts_at >= now() + 2h (exactly 2h away is allowed), so a request
// at the boundary always gets the same answer.
const lockSlots = async (client, slotIds) => {
  const { rows } = await client.query(
    `SELECT slot_id, center_id, vaccine_type, capacity, booked_count, starts_at, status,
            starts_at >= now() + ${CUTOFF} AS meets_cutoff
       FROM slots
      WHERE slot_id = ANY($1::int[])
      ORDER BY slot_id
        FOR UPDATE`,
    [slotIds]
  );
  return new Map(rows.map((row) => [row.slot_id, row]));
};

// Locks one appointment. The patient lock is taken first (to keep the lock
// order), which means we must look up the owner before locking the row.
const lockAppointment = async (client, appointmentId) => {
  const owner = await client.query('SELECT patient_id FROM appointments WHERE appointment_id = $1', [
    appointmentId,
  ]);
  if (owner.rowCount === 0) {
    throw new AppError(404, 'APPOINTMENT_NOT_FOUND', `Appointment ${appointmentId} does not exist`);
  }
  await lockPatient(client, owner.rows[0].patient_id);

  const { rows } = await client.query(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE appointment_id = $1 FOR UPDATE`,
    [appointmentId]
  );
  return rows[0];
};

// ---------------------------------------------------------------------------
// Rule checks (run while the slot row is locked, so they cannot go stale)
// ---------------------------------------------------------------------------

const assertSlotBookable = (slot, slotId) => {
  if (!slot) {
    throw new AppError(404, 'SLOT_NOT_FOUND', `Slot ${slotId} does not exist`);
  }
  if (slot.status !== 'OPEN') {
    throw new AppError(409, 'SLOT_CLOSED', `Slot ${slotId} is closed`);
  }
  if (!slot.meets_cutoff) {
    throw new AppError(
      422,
      'CUTOFF_PASSED',
      `Slot ${slotId} starts in less than 2 hours; online booking for it is closed`
    );
  }
};

const assertSlotHasRoom = (slot) => {
  if (slot.booked_count >= slot.capacity) {
    throw new AppError(409, 'SLOT_FULL', `Slot ${slot.slot_id} is fully booked`, {
      capacity: slot.capacity,
      booked_count: slot.booked_count,
    });
  }
};

// The DB constraints should never fire (the locked checks above run first),
// but if they do we still return the right business error, not a 500.
const translateConstraintError = (error) => {
  if (error.code === '23505' && error.constraint === 'appointments_one_active_per_patient') {
    return new AppError(409, 'PATIENT_HAS_ACTIVE_APPOINTMENT', 'Patient already has an active appointment');
  }
  if (error.code === '23514' && error.constraint === 'slots_booked_count_within_capacity') {
    return new AppError(409, 'SLOT_FULL', 'Slot is fully booked');
  }
  return error;
};

// ---------------------------------------------------------------------------
// Writes (caller must already hold the patient and slot locks)
// ---------------------------------------------------------------------------

const createAppointment = async (client, patientId, slotId) => {
  try {
    const { rows: [appointment] } = await client.query(
      `INSERT INTO appointments (patient_id, slot_id) VALUES ($1, $2) RETURNING ${APPOINTMENT_COLUMNS}`,
      [patientId, slotId]
    );
    const { rows: [slot] } = await client.query(
      `UPDATE slots SET booked_count = booked_count + 1
        WHERE slot_id = $1
        RETURNING capacity - booked_count AS remaining`,
      [slotId]
    );
    await client.query('UPDATE patients SET active_appointment_id = $2 WHERE patient_id = $1', [
      patientId,
      appointment.appointment_id,
    ]);
    return { appointment, remaining: slot.remaining };
  } catch (error) {
    throw translateConstraintError(error);
  }
};

// Cancels an ACTIVE appointment: frees the seat and clears the patient flag.
// Only called when we hold the appointment lock and saw status = 'ACTIVE',
// so the decrement can happen at most once per appointment.
// The seat is freed even if the slot has since been CLOSED, so the count never drifts.
const releaseAppointment = async (client, appointment) => {
  const { rows: [cancelled] } = await client.query(
    `UPDATE appointments SET status = 'CANCELLED', cancelled_at = now()
      WHERE appointment_id = $1 AND status = 'ACTIVE'
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [appointment.appointment_id]
  );
  const { rows: [slot] } = await client.query(
    `UPDATE slots SET booked_count = booked_count - 1
      WHERE slot_id = $1
      RETURNING slot_id, capacity, booked_count, capacity - booked_count AS remaining`,
    [appointment.slot_id]
  );
  await client.query(
    'UPDATE patients SET active_appointment_id = NULL WHERE patient_id = $1 AND active_appointment_id = $2',
    [appointment.patient_id, appointment.appointment_id]
  );
  return { cancelled, slot };
};

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

const bookInTransaction = async (client, patientId, slotId) => {
  const patient = await lockPatient(client, patientId);
  const slot = (await lockSlots(client, [slotId])).get(slotId);

  assertSlotBookable(slot, slotId);
  if (patient.active_appointment_id !== null) {
    throw new AppError(409, 'PATIENT_HAS_ACTIVE_APPOINTMENT', 'Patient already has an active appointment', {
      active_appointment_id: patient.active_appointment_id,
    });
  }
  assertSlotHasRoom(slot);

  const { appointment, remaining } = await createAppointment(client, patientId, slotId);
  return {
    statusCode: 201,
    body: {
      success: true,
      appointment_id: appointment.appointment_id,
      patient_id: patientId,
      slot_id: slotId,
      remaining,
    },
  };
};

// POST /book. The idempotency key is claimed in the SAME transaction as the
// booking, so "key recorded" and "booking made" commit or roll back together.
//   - New key: book, store the response, commit.
//   - Key already committed: replay the stored response, book nothing.
//   - Same key in flight on another instance: the PRIMARY KEY insert waits
//     for that transaction, then sees its committed key and replays it.
const book = ({ patientId, slotId, idempotencyKey }) =>
  withTransaction(async (client) => {
    const claimed = await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, patient_id, slot_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, patientId, slotId]
    );

    if (claimed.rowCount === 0) {
      const { rows: [stored] } = await client.query(
        'SELECT patient_id, slot_id, status_code, response FROM idempotency_keys WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (stored.patient_id !== patientId || stored.slot_id !== slotId) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request (patient_id/slot_id differ)'
        );
      }
      return { statusCode: stored.status_code, body: { ...stored.response, idempotent_replay: true } };
    }

    // Business failures (slot full, closed, ...) are also stored, so a retry
    // gets the same answer. The savepoint undoes any partial work first.
    await client.query('SAVEPOINT booking');
    let result;
    try {
      result = await bookInTransaction(client, patientId, slotId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error; // unexpected: roll back everything, key included
      await client.query('ROLLBACK TO SAVEPOINT booking');
      result = { statusCode: error.status, body: error.toBody() };
    }

    await client.query(
      'UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE idempotency_key = $1',
      [idempotencyKey, result.statusCode, result.body]
    );
    return result;
  });

// POST /appointments/:id/cancel. A second call (or a call racing the first)
// sees status = 'CANCELLED' under the lock and changes nothing.
const cancel = (appointmentId) =>
  withTransaction(async (client) => {
    const appointment = await lockAppointment(client, appointmentId);
    if (appointment.status !== 'ACTIVE') {
      return { success: true, already_cancelled: true, appointment };
    }
    const { cancelled, slot } = await releaseAppointment(client, appointment);
    return { success: true, already_cancelled: false, appointment: cancelled, slot };
  });

// POST /appointments/:id/reschedule. Cancel + book in ONE transaction.
// Any failure rolls back both halves: the original appointment and both
// slot counts stay exactly as they were.
const reschedule = (appointmentId, newSlotId) =>
  withTransaction(async (client) => {
    const appointment = await lockAppointment(client, appointmentId);
    if (appointment.status !== 'ACTIVE') {
      throw new AppError(409, 'APPOINTMENT_NOT_ACTIVE', `Appointment ${appointmentId} is not active`);
    }
    if (appointment.slot_id === newSlotId) {
      throw new AppError(409, 'SAME_SLOT', 'Appointment is already in this slot');
    }

    // Lock old and new slot together, in id order (deadlock-free).
    const slots = await lockSlots(client, [appointment.slot_id, newSlotId]);
    const newSlot = slots.get(newSlotId);
    assertSlotBookable(newSlot, newSlotId);
    assertSlotHasRoom(newSlot);

    const { cancelled } = await releaseAppointment(client, appointment);
    const { appointment: created, remaining } = await createAppointment(
      client,
      appointment.patient_id,
      newSlotId
    );

    return {
      success: true,
      cancelled_appointment_id: cancelled.appointment_id,
      appointment_id: created.appointment_id,
      patient_id: created.patient_id,
      slot_id: newSlotId,
      remaining,
    };
  });

module.exports = { book, cancel, reschedule };
