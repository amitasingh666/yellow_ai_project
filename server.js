require('dotenv').config();

const express = require('express');
const db = require('./db');
const bookingRoutes = require('./src/routes/booking');
const cancellationRoutes = require('./src/routes/cancellation');
const slotRoutes = require('./src/routes/slots');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.status(200).json({ message: 'Server is running' });
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

app.use('/api', bookingRoutes);
app.use('/api', cancellationRoutes);
app.use('/api', slotRoutes);

const start = async () => {
  await db.initDb();

  const server = app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
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
