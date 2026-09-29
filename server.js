```js
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id UUID PRIMARY KEY,
      sender_address VARCHAR(34) NOT NULL,
      recipient_address VARCHAR(34) NOT NULL,
      amount_raw NUMERIC(78,0) NOT NULL,
      status VARCHAR(32) NOT NULL,
      deposit_txid VARCHAR(128) UNIQUE,
      payout_txid VARCHAR(128) UNIQUE,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_payment_requests_status
      ON payment_requests(status);

    CREATE INDEX IF NOT EXISTS idx_payment_requests_created_at
      ON payment_requests(created_at);
  `);

  console.log("Database initialized");
}
```
