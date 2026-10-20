async function quoteFrozen(db, quoteId) {
  return Boolean(await db.prepare(`SELECT 1 FROM quote_customer_confirmations WHERE quote_id=? AND status='confirmed'
    UNION SELECT 1 FROM quote_verifications WHERE quote_id=? LIMIT 1`).get(quoteId, quoteId));
}
module.exports = {quoteFrozen};
