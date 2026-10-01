const http = require('node:http');
const port = Number(process.env.TOONFLOW_DB_STARTUP_TEST_PORT);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Temporary startup test port required');
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (requested, ...rest) {
  if (requested !== 10588) return listen.call(this, requested, ...rest);
  return listen.call(this, port, '127.0.0.1', ...rest);
};
