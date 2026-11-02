require('dotenv').config();

const { Pool } = require('pg');

// Defaults match the `clinic-db` Docker container (postgres:16 on localhost:5432).
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'pass',
  database: process.env.DB_NAME || 'clinic',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL error:', error);
});

const schema = `
  CREATE TABLE IF NOT EXISTS patients (
    patient_id  SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    phone       VARCHAR(20)  NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS slots (
    slot_id       SERIAL PRIMARY KEY,
    center_id     INTEGER      NOT NULL,
    vaccine_type  VARCHAR(50)  NOT NULL,
    capacity      INTEGER      NOT NULL CHECK (capacity >= 0),
    starts_at     TIMESTAMPTZ  NOT NULL,
    status        VARCHAR(10)  NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    booking_id  SERIAL PRIMARY KEY,
    patient_id  INTEGER      NOT NULL REFERENCES patients (patient_id),
    slot_id     INTEGER      NOT NULL REFERENCES slots (slot_id),
    status      VARCHAR(20)  NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'CANCELLED')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  -- A patient can hold only one active booking per slot.
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_patient_slot
    ON bookings (patient_id, slot_id) WHERE status = 'BOOKED';
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

const initDb = async () => {
  await pool.query('SELECT 1');
  await pool.query(schema);
  console.log('Connected to PostgreSQL and schema is ready');
};

module.exports = { pool, query, withTransaction, initDb };
