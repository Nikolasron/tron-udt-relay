```js
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { TronWeb } = require("tronweb");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const TRON_HOST = process.env.TRON_HOST || "https://api.trongrid.io";
const TRONGRID_API_KEY = process.env.TRONGRID_API_KEY;
const PRIVATE_KEY = process.env.TRON_PRIVATE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const USDT_CONTRACT =
  process.env.USDT_CONTRACT ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_DECIMALS = Number(process.env.USDT_DECIMALS || 6);
const MAX_USDT = Number(process.env.MAX_USDT || 1000);
const FEE_LIMIT_SUN = Number(
  process.env.FEE_LIMIT_SUN || 100000000
);
const POLL_INTERVAL_MS = Number(
  process.env.POLL_INTERVAL_MS || 10000
);
const REQUEST_EXPIRY_MINUTES = Number(
  process.env.REQUEST_EXPIRY_MINUTES || 30
);

if (!TRONGRID_API_KEY) {
  throw new Error("Missing TRONGRID_API_KEY");
}

if (!PRIVATE_KEY) {
  throw new Error("Missing TRON_PRIVATE_KEY");
}

if (!/^[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  throw new Error("TRON_PRIVATE_KEY must be a 64-character hexadecimal private key");
}

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

if (!Number.isInteger(USDT_DECIMALS) || USDT_DECIMALS < 0 || USDT_DECIMALS > 18) {
  throw new Error("Invalid USDT_DECIMALS");
}

const tronWeb = new TronWeb({
  fullHost: TRON_HOST,
  headers: {
    "TRON-PRO-API-KEY": TRONGRID_API_KEY
  },
  privateKey: PRIVATE_KEY
});

const RELAY_ADDRESS = tronWeb.defaultAddress.base58;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

app.use(helmet());
app.use(express.json({ limit: "100kb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/", limiter);

function isValidTronAddress(address) {
  return (
    typeof address === "string" &&
    tronWeb.isAddress(address)
  );
}

function amountToRaw(amount) {
  if (
    typeof amount !== "string" &&
    typeof amount !== "number"
  ) {
    throw new Error("Invalid amount");
  }

  const value = String(amount).trim();

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Invalid amount format");
  }

  const [whole, fraction = ""] = value.split(".");

  if (fraction.length > USDT_DECIMALS) {
    throw new Error("Too many decimal places");
  }

  const paddedFraction =
    fraction.padEnd(USDT_DECIMALS, "0");

  return BigInt(
    whole + paddedFraction
  );
}

function rawToAmount(raw) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(USDT_DECIMALS);

  const whole = value / base;
  const fraction = value % base;

  if (fraction === 0n) {
    return whole.toString();
  }

  return (
    whole.toString() +
    "." +
    fraction
      .toString()
      .padStart(USDT_DECIMALS, "0")
      .replace(/0+$/, "")
  );
}

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

async function tronRequest(endpoint, options = {}) {
  const response = await fetch(
    `${TRON_HOST}${endpoint}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "TRON-PRO-API-KEY": TRONGRID_API_KEY,
        ...(options.headers || {})
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `TRON API ${response.status}: ${text.slice(0, 500)}`
    );
  }

  return response.json();
}

async function getTransactionInfo(txid) {
  return tronRequest(
    "/walletsolidity/gettransactioninfobyid",
    {
      method: "POST",
      body: JSON.stringify({
        value: txid
      })
    }
  );
}

async function getTransactionEvents(txid) {
  return tronRequest(
    `/v1/transactions/${encodeURIComponent(txid)}/events?only_confirmed=true`
  );
}

async function verifyTransfer(
  txid,
  expectedFrom,
  expectedTo,
  expectedAmountRaw
) {
  const info = await getTransactionInfo(txid);

  if (!info || !info.id) {
    return false;
  }

  const receiptResult =
    info.receipt?.result ||
    info.receipt?.receipt?.result;

  if (receiptResult && receiptResult !== "SUCCESS") {
    return false;
  }

  const eventsResponse =
    await getTransactionEvents(txid);

  const events =
    Array.isArray(eventsResponse?.data)
      ? eventsResponse.data
      : [];

  const expectedAmount = String(expectedAmountRaw);

  return events.some((event) => {
    if (event.event_name !== "Transfer") {
      return false;
    }

    const contract =
      event.contract_address ||
      event.address;

    const result = event.result || {};

    return (
      contract === USDT_CONTRACT &&
      result.from === expectedFrom &&
      result.to === expectedTo &&
      String(result.value) === expectedAmount
    );
  });
}

async function findDeposit(request) {
  const createdAt =
    new Date(request.created_at).getTime();

  const minTimestamp =
    Math.max(
      0,
      createdAt - 5 * 60 * 1000
    );

  const endpoint =
    `/v1/accounts/${RELAY_ADDRESS}/transactions/trc20` +
    `?limit=200` +
    `&only_confirmed=true` +
    `&only_to=true` +
    `&contract_address=${encodeURIComponent(USDT_CONTRACT)}` +
    `&min_timestamp=${minTimestamp}`;

  const response = await tronRequest(endpoint);

  const transactions =
    Array.isArray(response?.data)
      ? response.data
      : [];

  for (const tx of transactions) {
    if (tx.type !== "Transfer") {
      continue;
    }

    if (tx.token_info?.address !== USDT_CONTRACT) {
      continue;
    }

    if (tx.from !== request.sender_address) {
      continue;
    }

    if (tx.to !== RELAY_ADDRESS) {
      continue;
    }

    if (
      String(tx.value) !==
      String(request.amount_raw)
    ) {
      continue;
    }

    const verified = await verifyTransfer(
      tx.transaction_id,
      request.sender_address,
      RELAY_ADDRESS,
      request.amount_raw
    );

    if (verified) {
      return tx.transaction_id;
    }
  }

  return null;
}

async function sendUSDT(recipient, amountRaw) {
  const contract =
    await tronWeb.contract().at(USDT_CONTRACT);

  const txid =
    await contract
      .transfer(
        recipient,
        String(amountRaw)
      )
      .send({
        feeLimit: FEE_LIMIT_SUN,
        callValue: 0,
        shouldPollResponse: false
      });

  return txid;
}

async function expireOldRequests() {
  await pool.query(
    `
    UPDATE payment_requests
    SET
      status = 'expired',
      updated_at = NOW(),
      error_message = 'Payment request expired'
    WHERE status = 'awaiting_deposit'
      AND created_at <
        NOW() - ($1 * INTERVAL '1 minute')
    `,
    [REQUEST_EXPIRY_MINUTES]
  );
}

async function processPayment(requestId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT *
      FROM payment_requests
      WHERE id = $1
      FOR UPDATE
      `,
      [requestId]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const request = result.rows[0];

    if (request.status === "completed") {
      await client.query("COMMIT");
      return;
    }

    if (request.status === "expired") {
      await client.query("COMMIT");
      return;
    }

    if (request.status === "awaiting_deposit") {
      await client.query("COMMIT");

      const depositTxid =
        await findDeposit(request);

      if (!depositTxid) {
        return;
      }

      const claim = await pool.query(
        `
        UPDATE payment_requests
        SET
          status = 'payout_pending',
          deposit_txid = $2,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'awaiting_deposit'
        `,
        [request.id, depositTxid]
      );

      if (claim.rowCount === 0) {
        return;
      }

      return processPayment(request.id);
    }

    if (request.status === "payout_pending") {
      await client.query(
        `
        UPDATE payment_requests
        SET
          status = 'payout_processing',
          updated_at = NOW()
        WHERE id = $1
        `,
        [request.id]
      );

      await client.query("COMMIT");

      try {
        const payoutTxid =
          await sendUSDT(
            request.recipient_address,
            request.amount_raw
          );

        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'payout_broadcast',
            payout_txid = $2,
            updated_at = NOW(),
            error_message = NULL
          WHERE id = $1
          `,
          [request.id, payoutTxid]
        );
      } catch (error) {
        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'payout_pending',
            updated_at = NOW(),
            error_message = $2
          WHERE id = $1
          `,
          [request.id, String(error.message).slice(0, 1000)]
        );
      }

      return;
    }

    if (request.status === "payout_processing") {
      await client.query("COMMIT");
      return;
    }

    if (request.status === "payout_broadcast") {
      await client.query("COMMIT");

      if (!request.payout_txid) {
        return;
      }

      const verified =
        await verifyTransfer(
          request.payout_txid,
          RELAY_ADDRESS,
          request.recipient_address,
          request.amount_raw
        );

      if (verified) {
        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'completed',
            updated_at = NOW(),
            error_message = NULL
          WHERE id = $1
            AND status = 'payout_broadcast'
          `,
          [request.id]
        );
      }

      return;
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error(
      `processPayment(${requestId}) failed:`,
      error
    );
  } finally {
    client.release();
  }
}

let workerRunning = false;

async function worker() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    await expireOldRequests();

    const result = await pool.query(`
      SELECT id
      FROM payment_requests
      WHERE status IN (
        'awaiting_deposit',
        'payout_pending',
        'payout_broadcast'
      )
      ORDER BY created_at ASC
      LIMIT 25
    `);

    for (const row of result.rows) {
      await processPayment(row.id);
    }
  } catch (error) {
    console.error("Worker error:", error);
  } finally {
    workerRunning = false;
  }
}

app.get("/api/config", (req, res) => {
  res.json({
    network: "TRON Mainnet",
    token: "USDT",
    contract: USDT_CONTRACT,
    decimals: USDT_DECIMALS,
    relayAddress: RELAY_ADDRESS,
    maxUSDT: MAX_USDT
  });
});

app.post("/api/requests", async (req, res) => {
  try {
    const {
      senderAddress,
      recipientAddress,
      amount
    } = req.body || {};

    if (!isValidTronAddress(senderAddress)) {
      return res.status(400).json({
        error: "Invalid sender address"
      });
    }

    if (!isValidTronAddress(recipientAddress)) {
      return res.status(400).json({
        error: "Invalid recipient address"
      });
    }

    if (senderAddress === recipientAddress) {
      return res.status(400).json({
        error: "Sender and recipient must be different"
      });
    }

    const amountRaw =
      amountToRaw(amount);

    const maxRaw =
      amountToRaw(String(MAX_USDT));

    if (amountRaw <= 0n) {
      return res.status(400).json({
        error: "Amount must be greater than zero"
      });
    }

    if (amountRaw > maxRaw) {
      return res.status(400).json({
        error: `Maximum amount is ${MAX_USDT} USDT`
      });
    }

    const id = crypto.randomUUID();

    await pool.query(
      `
      INSERT INTO payment_requests (
        id,
        sender_address,
        recipient_address,
        amount_raw,
        status
      )
      VALUES ($1, $2, $3, $4, 'awaiting_deposit')
      `,
      [
        id,
        senderAddress,
        recipientAddress,
        amountRaw.toString()
      ]
    );

    res.status(201).json({
      id,
      status: "awaiting_deposit",
      relayAddress: RELAY_ADDRESS,
      amount: rawToAmount(amountRaw)
    });
  } catch (error) {
    console.error("Create request error:", error);

    res.status(400).json({
      error: error.message || "Unable to create payment request"
    });
  }
});

app.get("/api/requests/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        sender_address,
        recipient_address,
        amount_raw,
        status,
        deposit_txid,
        payout_txid,
        error_message,
        created_at,
        updated_at
      FROM payment_requests
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Payment request not found"
      });
    }

    const row = result.rows[0];

    res.json({
      id: row.id,
      senderAddress: row.sender_address,
      recipientAddress: row.recipient_address,
      amount: rawToAmount(row.amount_raw),
      status: row.status,
      depositTxid: row.deposit_txid,
      payoutTxid: row.payout_txid,
      error: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error("Status error:", error);

    res.status(500).json({
      error: "Unable to retrieve request status"
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "ok",
      network: "TRON Mainnet",
      relayAddress: RELAY_ADDRESS
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: "error"
    });
  }
});

app.use(express.static(
  path.join(__dirname, "public")
));

async function verifyContract() {
  const contract =
    await tronWeb.contract().at(USDT_CONTRACT);

  const symbol =
    await contract.symbol();

  const decimals =
    await contract.decimals();

  console.log("USDT contract:", USDT_CONTRACT);
  console.log("Token symbol:", symbol);
  console.log("Token decimals:", decimals);

  if (String(symbol).toUpperCase() !== "USDT") {
    throw new Error(
      `Unexpected token symbol: ${symbol}`
    );
  }

  if (Number(decimals) !== USDT_DECIMALS) {
    throw new Error(
      `Unexpected token decimals: ${decimals}`
    );
  }
}

async function start() {
  await initDatabase();
  await verifyContract();

  app.listen(PORT, () => {
    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      `Relay address: ${RELAY_ADDRESS}`
    );

    console.log(
      `Network: TRON Mainnet`
    );
  });

  await worker();

  setInterval(
    worker,
    POLL_INTERVAL_MS
  );
}

start().catch((error) => {
  console.error(
    "Startup failed:",
    error
  );

  process.exit(1);
});
```
