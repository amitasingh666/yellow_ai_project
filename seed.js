// Resets the database and inserts demo slots, with times relative to "now"
// so the 2-hour cutoff behaves the same whenever you run it.
// WARNING: drops all existing data.
const { pool, resetDb } = require('./db');

const hoursFromNow = (hours) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

// [center_id, vaccine_type, capacity, starts_at, status]
const slots = [
  [1, 'COVISHIELD', 10, hoursFromNow(24), 'OPEN'],
  [1, 'COVAXIN', 5, hoursFromNow(26), 'OPEN'],
  [2, 'COVISHIELD', 2, hoursFromNow(48), 'OPEN'],
  [2, 'COVAXIN', 5, hoursFromNow(50), 'CLOSED'], // closed slot -> SLOT_CLOSED
  [3, 'COVISHIELD', 5, hoursFromNow(1), 'OPEN'], // starts in 1h -> CUTOFF_PASSED
];

const seed = async () => {
  await resetDb();

  for (const [centerId, vaccineType, capacity, startsAt, status] of slots) {
    await pool.query(
      `INSERT INTO slots (center_id, vaccine_type, capacity, starts_at, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [centerId, vaccineType, capacity, startsAt, status]
    );
  }

  const { rows } = await pool.query(
    `SELECT slot_id, center_id, vaccine_type, capacity, booked_count,
            capacity - booked_count AS remaining, starts_at, status
       FROM slots ORDER BY slot_id`
  );
  console.log('Seeded slots:');
  console.table(rows);
};

seed()
  .catch((error) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
