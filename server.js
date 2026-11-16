require('dotenv').config({ quiet: true });

const express = require('express');
const db = require('./db');
const { AppError } = require('./src/errors');
const slotRoutes = require('./src/routes/slots');
const bookRoutes = require('./src/routes/book');
const appointmentRoutes = require('./src/routes/appointments');
const patientRoutes = require('./src/routes/patients');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Vaccine appointment scheduling service', pid: process.pid, port });
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', pid: process.pid });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use(slotRoutes);
app.use(bookRoutes);
app.use(appointmentRoutes);
app.use(patientRoutes);

app.use((req, res) => {
  res.status(404).json(new AppError(404, 'ROUTE_NOT_FOUND', `${req.method} ${req.path} not found`).toBody());
});

// Express 5 forwards rejected promises from async handlers here.
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error instanceof AppError) {
    return res.status(error.status).json(error.toBody());
  }
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON').toBody());
  }
  console.error(`[${process.pid}] Unhandled error on ${req.method} ${req.path}:`, error);
  return res.status(500).json(new AppError(500, 'INTERNAL_ERROR', 'Internal server error').toBody());
});

const start = async () => {
  await db.initDb();

  const server = app.listen(port, () => {
    console.log(`[${process.pid}] Server is running at http://localhost:${port}`);
  });

  server.on('error', (error) => {
    console.error('Failed to start server:', error);
    process.exitCode = 1;
  });

  const shutdown = () => {
    server.close(() => db.pool.end());
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((error) => {
  console.error('Failed to connect to database:', error.message);
  process.exit(1);
});
