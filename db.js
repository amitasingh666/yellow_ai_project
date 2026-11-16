require('dotenv').config({ quiet: true });

const { Pool, types } = require('pg');

// Return BIGINT (patient_id, COUNT(*)) as JS numbers instead of strings.
// Safe here because ids stay far below Number.MAX_SAFE_INTEGER.
types.setTypeParser(20, (value) => Number(value));

// Defaults match the `clinic-db` Docker container (postgres:16 on localhost:5432).
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'pass',
  database: process.env.DB_NAME || 'clinic',
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL error:', error);
});

const schema = `
  -- capacity never changes after creation; booked_count is the live counter.
  -- The CHECK constraint is the last line of defence: even a buggy code path
  -- cannot push booked_count above capacity or below zero.
  CREATE TABLE IF NOT EXISTS slots (
    slot_id       SERIAL PRIMARY KEY,
    center_id     INTEGER      NOT NULL,
    vaccine_type  VARCHAR(50)  NOT NULL,
    capacity      INTEGER      NOT NULL CHECK (capacity > 0),
    booked_count  INTEGER      NOT NULL DEFAULT 0,
    starts_at     TIMESTAMPTZ  NOT NULL,
    status        VARCHAR(10)  NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT slots_booked_count_within_capacity
      CHECK (booked_count >= 0 AND booked_count <= capacity)
  );

  -- One row per patient. It is the lock that serializes all of a patient's
  -- operations, and active_appointment_id is the "has active appointment" flag.
  CREATE TABLE IF NOT EXISTS patients (
    patient_id             BIGINT PRIMARY KEY,
    active_appointment_id  INTEGER
  );

  CREATE TABLE IF NOT EXISTS appointments (
    appointment_id  SERIAL PRIMARY KEY,
    patient_id      BIGINT       NOT NULL REFERENCES patients (patient_id),
    slot_id         INTEGER      NOT NULL REFERENCES slots (slot_id),
    status          VARCHAR(10)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    cancelled_at    TIMESTAMPTZ
  );

  -- Backstop for "one active appointment per patient, across all centers".
  CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_active_per_patient
    ON appointments (patient_id) WHERE status = 'ACTIVE';

  CREATE INDEX IF NOT EXISTS appointments_slot_id_idx ON appointments (slot_id);

  -- Stores the first result for each Idempotency-Key so retries replay it.
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key  VARCHAR(255) PRIMARY KEY,
    patient_id       BIGINT       NOT NULL,
    slot_id          INTEGER      NOT NULL,
    status_code      INTEGER,
    response         JSONB,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
`;

const query = (text, params) => pool.query(text, params);

// Runs fn inside a transaction; commits on success, rolls back on error.
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Two app instances may boot at the same moment; an advisory lock stops
// their CREATE TABLE IF NOT EXISTS statements from racing each other.
const SCHEMA_LOCK_ID = 727001;

const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(schema);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_ID]).catch(() => {});
    client.release();
  }
};

// Drops every table (including the pre-redesign `bookings` table) and recreates the schema.
const resetDb = async () => {
  await pool.query('DROP TABLE IF EXISTS idempotency_keys, appointments, bookings, patients, slots CASCADE');
  await initDb();
};

module.exports = { pool, query, withTransaction, initDb, resetDb };
