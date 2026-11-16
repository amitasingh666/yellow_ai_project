const { AppError } = require('./errors');

// Accepts 5 or "5"; rejects 0, negatives, decimals, "5abc", etc.
const parsePositiveInt = (value, field) => {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', `${field} must be a positive integer`);
  }
  return number;
};

module.exports = { parsePositiveInt };
