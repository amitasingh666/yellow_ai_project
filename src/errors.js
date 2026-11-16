// An expected, client-facing failure with a stable machine-readable code.
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody() {
    const error = { code: this.code, message: this.message };
    if (this.details) error.details = this.details;
    return { success: false, error };
  }
}

module.exports = { AppError };
