// Concurrency test suite.
//
// Starts TWO separate app processes (ports 4001 and 4002) against the same
// PostgreSQL database and spreads every burst of requests across both, so any
// correctness that relied on in-process memory/locks would be exposed.
//
// After each scenario it checks the database directly for invariants:
//   - slots.booked_count == number of ACTIVE appointments in that slot
//   - each patient has at most one ACTIVE appointment
//   - patients.active_appointment_id points at exactly that appointment (or is NULL)
//
// Run with:  npm test     (requires the clinic-db container to be running)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../db');

const PORTS = [4001, 4002];
const BASES = PORTS.map((port) => `http://localhost:${port}`);
const servers = [];

// Unique patient ids per run, so re-running never collides with old data.
let nextPatientId = Date.now() * 100;
const newPatient = () => nextPatientId++;

const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

// Request i goes to instance i % 2, so every burst hits both processes.
const call = async (instance, method, urlPath, body, headers = {}) => {
  const res = await fetch(BASES[instance % BASES.length] + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const createSlot = async (overrides = {}) => {
  const res = await call(0, 'POST', '/slots', {
    center_id: 1,
    vaccine_type: 'COVISHIELD',
    capacity: 10,
    starts_at: hoursFromNow(24),
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const book = (instance, patientId, slotId, key = randomUUID()) =>
  call(instance, 'POST', '/book', { patient_id: patientId, slot_id: slotId }, { 'Idempotency-Key': key });

const getSlot = async (slotId, instance = 0) => (await call(instance, 'GET', `/slots/${slotId}`)).body;

const countBy = (responses, predicate) => responses.filter(predicate).length;
const errorCode = (res) => res.body?.error?.code;

// Checks the DB invariants for the given slots and patients.
const assertConsistent = async (slotIds, patientIds) => {
  const slots = await db.query(
    `SELECT s.slot_id, s.capacity, s.booked_count,
            COUNT(a.appointment_id) FILTER (WHERE a.status = 'ACTIVE')::int AS active
       FROM slots s
       LEFT JOIN appointments a ON a.slot_id = s.slot_id
      WHERE s.slot_id = ANY($1::int[])
      GROUP BY s.slot_id`,
    [slotIds]
  );
  for (const slot of slots.rows) {
    assert.equal(slot.booked_count, slot.active, `slot ${slot.slot_id}: booked_count != active appointments`);
    assert.ok(slot.booked_count <= slot.capacity, `slot ${slot.slot_id}: over capacity`);
    assert.ok(slot.booked_count >= 0, `slot ${slot.slot_id}: negative booked_count`);
  }

  if (patientIds.length === 0) return;
  const patients = await db.query(
    `SELECT p.patient_id, p.active_appointment_id,
            COALESCE(array_agg(a.appointment_id) FILTER (WHERE a.status = 'ACTIVE'), '{}') AS active_ids
       FROM patients p
       LEFT JOIN appointments a ON a.patient_id = p.patient_id
      WHERE p.patient_id = ANY($1::bigint[])
      GROUP BY p.patient_id`,
    [patientIds]
  );
  for (const p of patients.rows) {
    assert.ok(p.active_ids.length <= 1, `patient ${p.patient_id} has ${p.active_ids.length} active appointments`);
    assert.equal(p.active_appointment_id, p.active_ids[0] ?? null, `patient ${p.patient_id}: flag out of sync`);
  }
};

const waitForHealthy = async (base) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return (await res.json()).pid;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${base} did not become healthy`);
};

before(async () => {
  await db.initDb();
  for (const port of PORTS) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    servers.push(child);
  }
  const pids = await Promise.all(BASES.map(waitForHealthy));
  assert.notEqual(pids[0], pids[1], 'the two instances must be separate processes');
  console.log(`# two app instances running: pid ${pids[0]} on :${PORTS[0]}, pid ${pids[1]} on :${PORTS[1]}`);
});

after(async () => {
  for (const child of servers) child.kill();
  await db.pool.end();
});

// ---------------------------------------------------------------------------
// Priority 1: slot capacity & one-active-appointment
// ---------------------------------------------------------------------------

test('capacity: 60 simultaneous bookings for a capacity-7 slot -> exactly 7 succeed', async () => {
  const slot = await createSlot({ capacity: 7 });
  const patients = Array.from({ length: 60 }, newPatient);

  const results = await Promise.all(patients.map((patientId, i) => book(i, patientId, slot.slot_id)));

  assert.equal(countBy(results, (r) => r.status === 201), 7);
  assert.equal(countBy(results, (r) => errorCode(r) === 'SLOT_FULL'), 53);

  for (const instance of [0, 1]) {
    const view = await getSlot(slot.slot_id, instance);
    assert.deepEqual(
      { booked_count: view.booked_count, remaining: view.remaining, capacity: view.capacity },
      { booked_count: 7, remaining: 0, capacity: 7 }
    );
  }
  await assertConsistent([slot.slot_id], patients);
});

test('one active appointment: same patient fires 12 bookings at 6 different slots -> exactly 1 succeeds', async () => {
  const slots = await Promise.all(
    Array.from({ length: 6 }, (_, i) => createSlot({ center_id: i + 1, vaccine_type: i % 2 ? 'COVAXIN' : 'COVISHIELD' }))
  );
  const patientId = newPatient();

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => book(i, patientId, slots[i % slots.length].slot_id))
  );

  assert.equal(countBy(results, (r) => r.status === 201), 1);
  assert.equal(countBy(results, (r) => errorCode(r) === 'PATIENT_HAS_ACTIVE_APPOINTMENT'), 11);

  const views = await Promise.all(slots.map((s) => getSlot(s.slot_id)));
  assert.equal(views.reduce((sum, v) => sum + v.booked_count, 0), 1);

  const current = await call(1, 'GET', `/patients/${patientId}/appointment`);
  assert.equal(current.body.appointment.appointment_id, results.find((r) => r.status === 201).body.appointment_id);
  await assertConsistent(slots.map((s) => s.slot_id), [patientId]);
});

// ---------------------------------------------------------------------------
// Priority 2: idempotency
// ---------------------------------------------------------------------------

test('idempotency: same Idempotency-Key sent 10x concurrently + 1 late retry -> charged once', async () => {
  const slot = await createSlot({ capacity: 5 });
  const patientId = newPatient();
  const key = randomUUID();

  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => book(i, patientId, slot.slot_id, key)));
  const lateRetry = await book(1, patientId, slot.slot_id, key);
  const all = [...burst, lateRetry];

  assert.ok(all.every((r) => r.status === 201), 'every replay returns the original 201 response');
  assert.equal(new Set(all.map((r) => r.body.appointment_id)).size, 1, 'all responses carry the same appointment_id');
  assert.equal(countBy(all, (r) => !r.body.idempotent_replay), 1, 'exactly one original, the rest are replays');
  assert.equal(lateRetry.headers.get('idempotent-replay'), 'true');

  assert.equal((await getSlot(slot.slot_id)).booked_count, 1);
  const rows = await db.query('SELECT COUNT(*)::int AS n FROM appointments WHERE patient_id = $1', [patientId]);
  assert.equal(rows.rows[0].n, 1, 'only one appointment row exists');
  await assertConsistent([slot.slot_id], [patientId]);
});

test('idempotency: reusing a key for a different request is rejected; missing key is rejected', async () => {
  const slotA = await createSlot();
  const slotB = await createSlot();
  const patientId = newPatient();
  const key = randomUUID();

  assert.equal((await book(0, patientId, slotA.slot_id, key)).status, 201);
  const misuse = await book(1, patientId, slotB.slot_id, key);
  assert.equal(misuse.status, 422);
  assert.equal(errorCode(misuse), 'IDEMPOTENCY_KEY_REUSED');

  const noKey = await call(0, 'POST', '/book', { patient_id: newPatient(), slot_id: slotA.slot_id });
  assert.equal(errorCode(noKey), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal((await getSlot(slotB.slot_id)).booked_count, 0);
});

// ---------------------------------------------------------------------------
// Priority 3: cancel & reschedule
// ---------------------------------------------------------------------------

test('cancel: called 10x concurrently on one appointment -> slot freed exactly once', async () => {
  const slot = await createSlot({ capacity: 5 });
  const [p1, p2] = [newPatient(), newPatient()];
  const target = await book(0, p1, slot.slot_id);
  await book(1, p2, slot.slot_id); // a second booking, so a double-free would show as 0 instead of 1
  assert.equal((await getSlot(slot.slot_id)).booked_count, 2);

  const id = target.body.appointment_id;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i, 'POST', `/appointments/${id}/cancel`)));
  const again = await call(0, 'POST', `/appointments/${id}/cancel`);

  assert.ok([...results, again].every((r) => r.status === 200));
  assert.equal(countBy(results, (r) => r.body.already_cancelled === false), 1, 'exactly one call did the cancel');
  assert.equal(again.body.already_cancelled, true);

  const view = await getSlot(slot.slot_id);
  assert.equal(view.booked_count, 1, 'freed once: 2 -> 1, not 0');
  assert.equal(view.remaining, 4);
  assert.equal((await call(1, 'GET', `/patients/${p1}/appointment`)).body.appointment, null);
  await assertConsistent([slot.slot_id], [p1, p2]);
});

test('reschedule racing a direct cancel on the same appointment (25 rounds) -> always consistent', async () => {
  const slotA = await createSlot({ capacity: 100 });
  const slotB = await createSlot({ capacity: 100 });
  const patients = [];
  const outcomes = { rescheduleWon: 0, cancelWon: 0 };

  for (let round = 0; round < 25; round++) {
    const patientId = newPatient();
    patients.push(patientId);
    const booked = await book(round, patientId, slotA.slot_id);
    const id = booked.body.appointment_id;

    // Reschedule on one instance, cancel on the other, at the same moment.
    const [resched, cancel] = await Promise.all([
      call(round, 'POST', `/appointments/${id}/reschedule`, { new_slot_id: slotB.slot_id }),
      call(round + 1, 'POST', `/appointments/${id}/cancel`),
    ]);
    const current = (await call(0, 'GET', `/patients/${patientId}/appointment`)).body.appointment;

    if (resched.status === 200) {
      // Reschedule committed first; the cancel then found the OLD appointment already cancelled.
      outcomes.rescheduleWon++;
      assert.equal(cancel.body.already_cancelled, true);
      assert.equal(current.appointment_id, resched.body.appointment_id);
      assert.equal(current.slot_id, slotB.slot_id);
    } else {
      // Cancel committed first; the reschedule failed cleanly.
      outcomes.cancelWon++;
      assert.equal(errorCode(resched), 'APPOINTMENT_NOT_ACTIVE');
      assert.equal(cancel.body.already_cancelled, false);
      assert.equal(current, null);
    }
  }

  const [a, b] = await Promise.all([getSlot(slotA.slot_id), getSlot(slotB.slot_id)]);
  assert.equal(a.booked_count, 0, 'every original appointment in A ended up released exactly once');
  assert.equal(b.booked_count, outcomes.rescheduleWon);
  await assertConsistent([slotA.slot_id, slotB.slot_id], patients);
  console.log(`# reschedule-vs-cancel outcomes: ${JSON.stringify(outcomes)}`);
});

test('reschedule: concurrent reschedules into a nearly-full slot never overbook and never lose the original', async () => {
  const source = await createSlot({ capacity: 20 });
  const target = await createSlot({ capacity: 3 });
  const patients = Array.from({ length: 12 }, newPatient);
  const booked = await Promise.all(patients.map((p, i) => book(i, p, source.slot_id)));

  const results = await Promise.all(
    booked.map((b, i) =>
      call(i, 'POST', `/appointments/${b.body.appointment_id}/reschedule`, { new_slot_id: target.slot_id })
    )
  );

  assert.equal(countBy(results, (r) => r.status === 200), 3);
  assert.equal(countBy(results, (r) => errorCode(r) === 'SLOT_FULL'), 9);
  assert.equal((await getSlot(target.slot_id)).booked_count, 3);
  assert.equal((await getSlot(source.slot_id)).booked_count, 9, 'failed reschedules kept their original seat');
  for (const p of patients) {
    assert.notEqual((await call(0, 'GET', `/patients/${p}/appointment`)).body.appointment, null, 'nobody left with zero');
  }
  await assertConsistent([source.slot_id, target.slot_id], patients);
});

// ---------------------------------------------------------------------------
// Everything else: closed slots, cutoff, unknown slot
// ---------------------------------------------------------------------------

test('closing a slot during a burst of bookings: every booking is either before the close or rejected', async () => {
  const slot = await createSlot({ capacity: 100 });
  // Waves are small enough to fit each instance's DB pool (10), so the ordering
  // happens at the Postgres row lock rather than in the app's connection queue.
  const patients = Array.from({ length: 12 }, newPatient);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Hold the slot's row lock from the test so requests are genuinely mid-flight:
  // wave 1 bookings queue up, then the close queues, then wave 2 queues.
  const blocker = await db.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM slots WHERE slot_id = $1 FOR UPDATE', [slot.slot_id]);

  const wave1 = Promise.all(patients.slice(0, 6).map((p, i) => book(i, p, slot.slot_id)));
  await sleep(300);
  const close = call(1, 'PATCH', `/slots/${slot.slot_id}`, { status: 'CLOSED' });
  await sleep(300);
  const wave2 = Promise.all(patients.slice(6).map((p, i) => book(i, p, slot.slot_id)));
  await sleep(300);

  await blocker.query('COMMIT'); // release: everything queued now races for the slot
  blocker.release();
  const results = [...(await wave1), ...(await wave2)];
  assert.equal((await close).status, 200);

  const ok = countBy(results, (r) => r.status === 201);
  const closed = countBy(results, (r) => errorCode(r) === 'SLOT_CLOSED');
  assert.equal(ok + closed, patients.length, 'only two possible answers: booked before close, or SLOT_CLOSED');
  assert.ok(closed > 0, 'requests that were in flight when the slot closed were rejected');
  assert.equal((await getSlot(slot.slot_id)).booked_count, ok, 'count matches exactly the successful bookings');

  const afterClose = await book(0, newPatient(), slot.slot_id);
  assert.equal(errorCode(afterClose), 'SLOT_CLOSED');
  await assertConsistent([slot.slot_id], patients);
  console.log(`# close-mid-burst: ${ok} booked before close, ${closed} rejected as SLOT_CLOSED`);
});

test('distinct errors: closed slot, cutoff window, unknown slot', async () => {
  const closed = await createSlot({ status: 'CLOSED' });
  const tooSoon = await createSlot({ starts_at: hoursFromNow(1.99) });
  const justOutside = await createSlot({ starts_at: hoursFromNow(2.01) });

  assert.equal(errorCode(await book(0, newPatient(), closed.slot_id)), 'SLOT_CLOSED');

  const cutoff = await book(1, newPatient(), tooSoon.slot_id);
  assert.equal(cutoff.status, 422);
  assert.equal(errorCode(cutoff), 'CUTOFF_PASSED');
  assert.equal((await book(0, newPatient(), justOutside.slot_id)).status, 201);

  const unknown = await book(1, newPatient(), 999999999);
  assert.equal(unknown.status, 404);
  assert.equal(errorCode(unknown), 'SLOT_NOT_FOUND');
});
