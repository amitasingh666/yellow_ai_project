const { pool, initDb, withTransaction } = require('./db');

const patients = [
  ['Amit Singh', '9876543210'],
  ['Priya Sharma', '9876543211'],
  ['Rahul Verma', '9876543212'],
  ['Sneha Gupta', '9876543213'],
  ['Vikram Patel', '9876543214'],
  ['Anjali Mehta', '9876543215'],
  ['Rohan Das', '9876543216'],
  ['Kavya Nair', '9876543217'],
  ['Arjun Reddy', '9876543218'],
];

const slots = [
  [1, 'COVISHIELD', 10, '2026-11-10T09:00:00+05:30', 'OPEN'],
  [1, 'COVAXIN', 5, '2026-11-10T11:00:00+05:30', 'OPEN'],
  [2, 'COVISHIELD', 8, '2026-11-11T10:00:00+05:30', 'OPEN'],
  [2, 'COVAXIN', 0, '2026-11-11T14:00:00+05:30', 'CLOSED'],
];

// [patient_id, slot_id, status]
const bookings = [
  [1, 1, 'BOOKED'],
  [2, 1, 'BOOKED'],
  [3, 2, 'BOOKED'],
  [4, 3, 'CANCELLED'],
];

const seed = async () => {
  await initDb();

  await withTransaction(async (client) => {
    // Start from empty tables so the seed can be re-run.
    await client.query('TRUNCATE bookings, slots, patients RESTART IDENTITY');

    for (const [name, phone] of patients) {
      await client.query('INSERT INTO patients (name, phone) VALUES ($1, $2)', [name, phone]);
    }

    for (const [centerId, vaccineType, capacity, startsAt, status] of slots) {
      await client.query(
        `INSERT INTO slots (center_id, vaccine_type, capacity, starts_at, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [centerId, vaccineType, capacity, startsAt, status]
      );
    }

    for (const [patientId, slotId, status] of bookings) {
      await client.query(
        'INSERT INTO bookings (patient_id, slot_id, status) VALUES ($1, $2, $3)',
        [patientId, slotId, status]
      );
    }
  });

  for (const table of ['patients', 'slots', 'bookings']) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
    console.log(`\n${table}:`);
    console.table(rows);
  }
};

seed()
  .catch((error) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
