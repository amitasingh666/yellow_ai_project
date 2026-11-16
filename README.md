# Vaccine appointment scheduling service

A Node.js (Express 5) + PostgreSQL service for booking vaccine slots. The goal is that
slot capacity and the one-active-appointment-per-patient rule stay **exactly** correct,
even when many requests arrive at once across **multiple app instances**.

## How to run

Prerequisites: Node.js 20+, and Docker Desktop with a `postgres:16` container named `clinic-db`
(user `postgres`, password `pass`, database `clinic`, port 5432).

```bash
npm install
npm run db:start     # start the clinic-db container
npm run seed         # WARNING: drops all tables, recreates the schema, inserts demo slots
npm run dev          # server on http://localhost:3000 (restarts when files change)
npm test             # concurrency test suite (starts its own two instances on :4001 and :4002)
```

Configuration comes from `.env` (gitignored). These are the defaults:

```
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=pass
DB_NAME=clinic
```

Other scripts: `npm run db:init` (create any missing tables), `npm run db:reset` (drop all tables
and recreate them), `npm run db:shell` (psql).

To run two instances by hand: `PORT=3001 npm start` and `PORT=3002 npm start` in two terminals.

## API

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/slots` | `{ center_id, vaccine_type, capacity, starts_at, status? }` | `201` slot |
| GET | `/slots` | | all slots with live counts |
| GET | `/slots/:slot_id` | | `{ slot_id, capacity, booked_count, remaining, status, ... }` |
| PATCH | `/slots/:slot_id` | `{ status: "OPEN" \| "CLOSED" }` | updated slot (lets a center close a slot) |
| POST | `/book` (header `Idempotency-Key`) | `{ slot_id, patient_id }` | `201 { success: true, appointment_id, remaining, ... }` |
| POST | `/appointments/:id/cancel` | | `200 { success: true, already_cancelled, ... }` |
| POST | `/appointments/:id/reschedule` | `{ new_slot_id }` | `200 { success: true, appointment_id, cancelled_appointment_id, remaining }` |
| GET | `/patients/:patient_id/appointment` | | `{ patient_id, appointment: {...} \| null }` |

Errors always look like `{ success: false, error: { code, message, details? } }`:

| HTTP | `code` | When |
|---|---|---|
| 409 | `PATIENT_HAS_ACTIVE_APPOINTMENT` | The patient already holds an active appointment (at any center, for any vaccine) |
| 409 | `SLOT_FULL` | `booked_count == capacity` |
| 409 | `SLOT_CLOSED` | The slot's status is `CLOSED` |
| 422 | `CUTOFF_PASSED` | The slot starts less than 2 hours from now |
| 404 | `SLOT_NOT_FOUND` | Unknown `slot_id` |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | `POST /book` without an `Idempotency-Key` header |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The same key was sent with a different `patient_id` or `slot_id` |
| — | *idempotency replay* | The same key and same body: returns the **original** status and body, plus `"idempotent_replay": true` and the header `Idempotent-Replay: true` |
| 404 | `APPOINTMENT_NOT_FOUND` | Unknown appointment id |
| 409 | `APPOINTMENT_NOT_ACTIVE` | Rescheduling an appointment that is already cancelled |
| 409 | `SAME_SLOT` | Rescheduling into the slot the appointment is already in |
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | Bad input |

Example:

```bash
curl -X POST localhost:3000/book -H "Content-Type: application/json" \
     -H "Idempotency-Key: 6f1c..." -d '{"slot_id":1,"patient_id":42}'
```

## Design

**The core decision: the database is the only source of truth.** Nothing about correctness lives in
process memory. Every operation is a single PostgreSQL transaction that takes row locks (`SELECT ... FOR UPDATE`),
so the guarantees hold for any number of app instances. All of this logic is in
[src/services/appointments.js](src/services/appointments.js).

Tables ([db.js](db.js)):

- `slots`: `capacity` is fixed, and `booked_count` is the live counter. The
  `CHECK (booked_count >= 0 AND booked_count <= capacity)` constraint means the database itself refuses to overbook.
- `patients`: one row per patient. It serves as the **per-patient lock**, and `active_appointment_id` is the
  "has active appointment" flag.
- `appointments`: has `status ACTIVE | CANCELLED`, plus a **partial unique index** `UNIQUE (patient_id) WHERE status = 'ACTIVE'`.
- `idempotency_keys`: the key is the primary key. Each row stores the request (patient_id, slot_id) and the first response.

**Lock order is always the same:** idempotency key → patient → appointment → slots (ascending `slot_id`).
Because every operation takes locks in this order, two of our operations can never deadlock each other.

## How each rule is enforced and verified

The test ([test/concurrency.test.js](test/concurrency.test.js)) starts **two separate `node server.js` processes**
on ports 4001 and 4002. It checks that they have different PIDs, and sends request *i* to instance *i % 2*, so every
burst hits both processes. After each scenario it also checks the database directly, verifying that
`booked_count` equals the number of ACTIVE appointments, that each patient has at most one ACTIVE appointment, and that
the patient flag matches that appointment.

| Rule | How it is enforced | How it is verified (test) |
|---|---|---|
| **Capacity is never exceeded** | The booking locks the slot row, checks `booked_count < capacity`, then inserts the appointment and increments `booked_count` in the same transaction. Concurrent bookings for a slot run one at a time on that row. A DB `CHECK` constraint is the backstop. | 60 simultaneous bookings for a capacity-7 slot result in exactly 7 successes and 53 `SLOT_FULL`. `booked_count = 7` and `remaining = 0` when read from **both** instances. |
| **One active appointment per patient, across all centers** | The booking locks the patient row first, so the same patient's requests run one at a time, and the second one sees the active flag. The partial unique index is the backstop. | One patient fires 12 bookings at 6 slots (different centers and vaccines) at once. Exactly 1 succeeds, 11 get `PATIENT_HAS_ACTIVE_APPOINTMENT`, and the total `booked_count` across the 6 slots is 1. |
| **2-hour cutoff, consistent at the boundary** | Checked in SQL as `starts_at >= now() + interval '2 hours'`, using the **database clock**. `now()` is one value for the whole transaction and is the same for every instance. The boundary is inclusive (exactly 2h away is allowed). | Slots starting in 1.99h are rejected with `CUTOFF_PASSED`, and slots starting in 2.01h are accepted. |
| **Slot closed mid-request is rejected** | The status is checked while the slot row lock is held. `PATCH /slots/:id` (the close) needs the same lock, so each booking happens either entirely before the close, or after it and sees `CLOSED`. | The test holds the slot's row lock, sends 6 bookings, then the close, then 6 more bookings, and releases the lock. The result is 6 booked and 6 `SLOT_CLOSED` (consistent across repeated runs), with `booked_count` equal to the successes. |
| **Cancel frees the slot only once** | Cancel locks the appointment. Only if its status is `ACTIVE` does it set it to `CANCELLED`, decrement `booked_count` and clear the patient flag. Later calls see `CANCELLED` and return `already_cancelled: true` without changing anything. The seat is freed even if the slot has since been closed, so the count never drifts. | A slot has 2 bookings. One appointment is cancelled 10 times concurrently, plus once more afterwards. Exactly one call performs the cancel, and `booked_count` goes from 2 to 1 (not 0). |
| **Reschedule is atomic** | Cancel-old and book-new run in **one transaction**, locking the patient, then the appointment, then both slots in id order. Any failure (new slot full, closed or past the cutoff) rolls back both halves. | (a) Reschedule and cancel race on the same appointment for 25 rounds across both instances, and every round ends in one of the two valid states. (b) 12 concurrent reschedules into a capacity-3 slot: 3 succeed and 9 fail with `SLOT_FULL` while keeping their original seat, so no patient is left with zero appointments. |
| **Idempotent `POST /book`** | The key is inserted into `idempotency_keys` in the **same transaction** as the booking, so the key and the booking commit (or roll back) together. A retry finds the stored response and replays it. A concurrent duplicate waits on the primary key until the first request commits, then replays. Business failures are stored too, so a retry gets the same answer. | 10 concurrent requests with the same key, plus a later retry, all return the same `appointment_id`. Exactly one is the original (the rest are marked `idempotent_replay`), only 1 appointment row exists, and `booked_count = 1`. Reusing the key for a different slot returns `IDEMPOTENCY_KEY_REUSED`. |
| **`GET /slots/:id` is always correct** | `booked_count` is changed in the same transaction as the appointment row, so the count is never "eventually" correct. | Every test compares `booked_count` with a direct `COUNT(*)` of ACTIVE appointments. |

## Trade-offs and what I cut

- **A popular slot is a serial queue.** All bookings for one slot wait on one row lock. That is correct, and fine at
  clinic scale, but it caps throughput for one very hot slot. If that became a problem, the next step would be to split a
  slot's capacity across several counter rows, or to put a queue in front of booking.
- **No automatic retry on deadlock or serialization errors.** The fixed lock order prevents deadlocks between our own
  operations, so a retry wrapper was not worth the complexity for this exercise.
- **Idempotency keys never expire.** A real system would delete them after about 24h, and would scope keys per client
  or API key. Both were left out.
- **No authentication, and patients are implicit.** A patient row is created on first booking because the brief
  identifies patients only by `patient_id`.
- **Closing a slot does not cancel existing appointments.** It only stops new bookings. Notifying or moving the
  patients already booked is out of scope.
- **The cutoff is judged at transaction start** (`now()`). A request that waits on a lock is still judged by when it
  arrived, which is deterministic and fair to the caller.
