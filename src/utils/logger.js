function serializeError(error) {
  if (!error) {
    return {};
  }

  return {
    name: error.name,
    message: error.message
  };
}

function log(level, message, meta = {}) {
  const payload = {
    level,
    message,
    ...meta,
    at: new Date().toISOString()
  };

  const output = JSON.stringify(payload);
  if (level === 'error') {
    console.error(output);
    return;
  }

  if (level === 'warn') {
    console.warn(output);
    return;
  }

  console.log(output);
}

module.exports = {
  info(message, meta) {
    log('info', message, meta);
  },
  warn(message, meta) {
    log('warn', message, meta);
  },
  error(message, error, meta = {}) {
    log('error', message, {
      ...meta,
      error: serializeError(error)
    });
  }
};
