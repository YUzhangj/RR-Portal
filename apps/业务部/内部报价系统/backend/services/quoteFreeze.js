async function quoteFrozen(db, quoteId) {
  return Boolean(await db.prepare(`SELECT 1 FROM quote_customer_confirmations WHERE quote_id=? AND status='confirmed'
    UNION SELECT 1 FROM quote_verifications WHERE quote_id=? LIMIT 1`).get(quoteId, quoteId));
}

// Every original-quote writer and customer confirmation takes this row first.
// A separate frozen SELECT is insufficient: confirmation could commit between
// that SELECT and the writer's UPDATE, leaving the frozen baseline stale.
async function lockQuote(db, quoteId) {
  if (Number.isSafeInteger(quoteId) && quoteId > 0) {
    await db.prepare(`SELECT id FROM quotes WHERE id=?${db.pool ? ' FOR UPDATE' : ''}`).get(quoteId);
  }
}

async function withQuoteLifecycle(db, quoteId, operation) {
  return db.transaction(async () => {
    await lockQuote(db, quoteId);
    return operation();
  })();
}

function quoteWriteRoute(db, resolveQuoteId, handler) {
  return async (req, res) => {
    const quoteId = await resolveQuoteId(req);
    let status = res.statusCode || 200, payload, hasResponse = false;
    // These routes produce JSON only. A successful handler is still provisional
    // until COMMIT succeeds; never acknowledge a transaction that rolls back.
    const pending = {
      status(code) { status = code; return pending; },
      json(body) { payload = body; hasResponse = true; return pending; },
    };
    await withQuoteLifecycle(db, Number(quoteId), () => handler(req, pending));
    if (hasResponse) return res.status(status).json(payload);
  };
}

async function lockFactoryQuotes(db, factoryCode) {
  // Stable order also prevents two simultaneous global publications deadlocking.
  // SQLite's adapter serializes the encompassing transaction on its connection.
  if (db.pool) await db.prepare('SELECT id FROM quotes WHERE factory_code=? ORDER BY id FOR UPDATE').all(factoryCode);
}
module.exports = { quoteFrozen, withQuoteLifecycle, quoteWriteRoute, lockQuote, lockFactoryQuotes };
