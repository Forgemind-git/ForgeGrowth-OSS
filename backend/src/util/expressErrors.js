// Errors from route handlers, handled once for every router in the process.
//
// Express 4 calls each handler through Layer.prototype.handle_request, which
// catches what a handler THROWS but ignores the promise an `async` handler
// RETURNS. A query that rejects inside `async (req, res) => { await pool.query(...) }`
// therefore never reached the error handler: it became an unhandled rejection,
// and Node 20 exits on those — one request for /api/chatbots/<not-a-number>
// (Postgres 22P02) took the whole backend down. Most routes here are async
// without a try/catch, so the fix belongs at this layer, not in each route.
//
// installAsyncErrorForwarding() patches the two Layer methods so a rejected
// promise goes to next(err) exactly like a thrown error. It is idempotent and
// applies to every Router and app built from this `express` copy, including the
// Social sub-app, whenever they were created.

const Layer = require('express/lib/router/layer');

const PATCHED = Symbol.for('forgegrowth.asyncErrorForwarding');

function forward(ret, next) {
  if (ret && typeof ret.then === 'function') {
    ret.then(undefined, (err) => next(err || new Error('Route handler rejected without a reason')));
  }
}

function installAsyncErrorForwarding() {
  if (Layer.prototype[PATCHED]) return;

  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();   // an error handler: not for this path
    try {
      forward(fn(req, res, next), next);
    } catch (err) {
      next(err);
    }
  };

  Layer.prototype.handle_error = function handleError(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);   // not an error handler
    try {
      forward(fn(error, req, res, next), next);
    } catch (err) {
      next(err);
    }
  };

  Layer.prototype[PATCHED] = true;
}

// Postgres "the value you sent is not valid for this column" — a malformed id,
// number or date in the request, not a server fault.
const INVALID_INPUT_CODES = new Set(['22P02', '22003', '22007', '22008']);

// The app's last middleware. Errors are `{ error: "human readable" }`, never a stack.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);   // a response is under way: let Express close it
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    // body-parser (bad JSON, too large) and handlers that set a 4xx on purpose.
    return res.status(status).json({ error: err.expose === false ? 'Bad request' : err.message });
  }
  if (INVALID_INPUT_CODES.has(err.code)) {
    return res.status(400).json({ error: 'A value in the request is not valid.' });
  }
  console.error('[Error]', req.method, req.originalUrl, err.message);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { installAsyncErrorForwarding, errorHandler };
