
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const { TronWeb } = require("tronweb");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(helmet());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/", limiter);

const PORT = process.env.PORT || 10000;

const TRON_HOST =
  process.env.TRON_HOST || "https://api.trongrid.io";

const TRONGRID_API_KEY =
  process.env.TRONGRID_API_KEY;

const TRON_PRIVATE_KEY =
  process.env.TRON_PRIVATE_KEY;

const USDT_CONTRACT =
  process.env.USDT_CONTRACT ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const USDT_DECIMALS =
  Number(process.env.USDT_DECIMALS || 6);

const MAX_USDT =
  Number(process.env.MAX_USDT || 1000);

const FEE_LIMIT_SUN =
  Number(process.env.FEE_LIMIT_SUN || 100000000);

const POLL_INTERVAL_MS =
  Number(process.env.POLL_INTERVAL_MS || 10000);

const REQUEST_EXPIRY_MINUTES =
  Number(process.env.REQUEST_EXPIRY_MINUTES || 30);

if (!TRONGRID_API_KEY) {
  throw new Error("TRONGRID_API_KEY is missing");
}

if (!TRON_PRIVATE_KEY) {
  throw new Error("TRON_PRIVATE_KEY is missing");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

/*
 * TRON connection
 */
const tronWeb = new TronWeb({
  fullHost: TRON_HOST,
  headers: {
    "TRON-PRO-API-KEY": TRONGRID_API_KEY
  },
  privateKey: TRON_PRIVATE_KEY
});

/*
 * Relay address derived from the server-side private key.
 * Never expose the private key to the browser.
 */
const RELAY_ADDRESS =
  tronWeb.address.fromPrivateKey(TRON_PRIVATE_KEY);

console.log("Relay address:", RELAY_ADDRESS);
console.log("USDT contract:", USDT_CONTRACT);

/*
 * PostgreSQL
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
 * DATABASE INITIALIZATION
 *
 * The SQL must remain inside this function.
 */
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

/*
 * Validate a TRON address
 */
function isValidTronAddress(address) {
  try {
    return tronWeb.isAddress(address);
  } catch {
    return false;
  }
}

/*
 * Convert USDT amount to raw units.
 * USDT on TRON uses 6 decimals.
 */
function amountToRaw(amount) {
  const value = Number(amount);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid amount");
  }

  if (value > MAX_USDT) {
    throw new Error(
      `Maximum amount is ${MAX_USDT} USDT`
    );
  }

  return BigInt(
    Math.round(
      value * 10 ** USDT_DECIMALS
    )
  ).toString();
}

/*
 * Convert raw USDT units to normal amount.
 */
function rawToAmount(raw) {
  return Number(raw) / 10 ** USDT_DECIMALS;
}

/*
 * Generate request ID.
 */
function createId() {
  return crypto.randomUUID();
}

/*
 * Get TRON transaction information.
 */
async function getTransactionInfo(txid) {
  const response = await fetch(
    `${TRON_HOST}/wallet/gettransactionbyid?value=${encodeURIComponent(txid)}`,
    {
      headers: {
        "TRON-PRO-API-KEY": TRONGRID_API_KEY
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `TRON transaction lookup failed: ${response.status}`
    );
  }

  return response.json();
}

/*
 * Get TRC-20 events for a transaction.
 */
async function getTransferEvents(txid) {
  const response = await fetch(
    `${TRON_HOST}/v1/transactions/${encodeURIComponent(txid)}/events`,
    {
      headers: {
        "TRON-PRO-API-KEY": TRONGRID_API_KEY
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `TRON event lookup failed: ${response.status}`
    );
  }

  const data = await response.json();

  return data.data || [];
}

/*
 * Verify a specific USDT transfer.
 */
async function verifyTransfer(
  txid,
  expectedSender,
  expectedAmountRaw
) {
  const tx =
    await getTransactionInfo(txid);

  if (!tx || !tx.txID) {
    return {
      valid: false,
      reason: "Transaction not found"
    };
  }

  if (!tx.ret || !Array.isArray(tx.ret)) {
    return {
      valid: false,
      reason: "Transaction status unavailable"
    };
  }

  const successful =
    tx.ret.some(
      item =>
        item.contractRet === "SUCCESS"
    );

  if (!successful) {
    return {
      valid: false,
      reason: "Transaction was not successful"
    };
  }

  const events =
    await getTransferEvents(txid);

  for (const event of events) {
    if (
      event.event_name !== "Transfer" ||
      event.contract !== USDT_CONTRACT
    ) {
      continue;
    }

    const result =
      event.result || {};

    const from = result.from;
    const to = result.to;
    const value =
      String(result.value || "0");

    if (
      from === expectedSender &&
      to === RELAY_ADDRESS &&
      value === String(expectedAmountRaw)
    ) {
      return {
        valid: true,
        from,
        to,
        amountRaw: value
      };
    }
  }

  return {
    valid: false,
    reason: "Matching USDT transfer not found"
  };
}

/*
 * Search the relay address for a matching deposit.
 */
async function findDeposit(request) {
  const url =
    `${TRON_HOST}/v1/accounts/${RELAY_ADDRESS}/transactions/trc20` +
    `?only_confirmed=true` +
    `&limit=200` +
    `&contract_address=${USDT_CONTRACT}`;

  const response =
    await fetch(url, {
      headers: {
        "TRON-PRO-API-KEY":
          TRONGRID_API_KEY
      }
    });

  if (!response.ok) {
    throw new Error(
      `TRON transfer lookup failed: ${response.status}`
    );
  }

  const data =
    await response.json();

  const transfers =
    data.data || [];

  for (const transfer of transfers) {
    if (
      transfer.to !== RELAY_ADDRESS ||
      transfer.from !== request.sender_address ||
      String(transfer.value) !==
        String(request.amount_raw)
    ) {
      continue;
    }

    const txid =
      transfer.transaction_id;

    if (!txid) {
      continue;
    }

    const verification =
      await verifyTransfer(
        txid,
        request.sender_address,
        request.amount_raw
      );

    if (verification.valid) {
      return txid;
    }
  }

  return null;
}

/*
 * Send USDT from the relay wallet.
 */
async function sendUSDT(
  recipient,
  amountRaw
) {
  const contract =
    await tronWeb
      .contract()
      .at(USDT_CONTRACT);

  const transaction =
    await contract
      .transfer(
        recipient,
        amountRaw
      )
      .send({
        feeLimit: FEE_LIMIT_SUN
      });

  return transaction;
}

/*
 * Expire old waiting requests.
 */
async function expireOldRequests() {
  await pool.query(
    `
    UPDATE payment_requests
    SET
      status = 'expired',
      updated_at = NOW()
    WHERE status = 'waiting'
      AND created_at <
        NOW() - ($1 * INTERVAL '1 minute')
    `,
    [REQUEST_EXPIRY_MINUTES]
  );
}

/*
 * Process one payment request.
 */
async function processPayment(request) {
  try {
    /*
     * Step 1:
     * Look for the sender's deposit.
     */
    if (request.status === "waiting") {
      const depositTxid =
        await findDeposit(request);

      if (!depositTxid) {
        return;
      }

      const updateResult =
        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'deposit_confirmed',
            deposit_txid = $1,
            updated_at = NOW()
          WHERE id = $2
            AND status = 'waiting'
          RETURNING *
          `,
          [
            depositTxid,
            request.id
          ]
        );

      if (updateResult.rowCount === 0) {
        return;
      }

      request =
        updateResult.rows[0];
    }

    /*
     * Step 2:
     * Lock the request for payout processing.
     */
    if (
      request.status ===
      "deposit_confirmed"
    ) {
      const updateResult =
        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'payout_processing',
            updated_at = NOW()
          WHERE id = $1
            AND status = 'deposit_confirmed'
          RETURNING *
          `,
          [request.id]
        );

      if (updateResult.rowCount === 0) {
        return;
      }

      request =
        updateResult.rows[0];
    }

    /*
     * Step 3:
     * Send the requested USDT payout.
     */
    if (
      request.status ===
      "payout_processing"
    ) {
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
            status = 'completed',
            payout_txid = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            payoutTxid,
            request.id
          ]
        );

        console.log(
          `Payment ${request.id} completed: ${payoutTxid}`
        );
      } catch (error) {
        await pool.query(
          `
          UPDATE payment_requests
          SET
            status = 'failed',
            error_message = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            String(
              error.message || error
            ),
            request.id
          ]
        );

        console.error(
          `Payout failed for ${request.id}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error(
      `Payment processing error ${request.id}:`,
      error
    );
  }
}

/*
 * Background worker.
 */
let workerRunning = false;

async function worker() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    await expireOldRequests();

    const result =
      await pool.query(
        `
        SELECT *
        FROM payment_requests
        WHERE status IN (
          'waiting',
          'deposit_confirmed',
          'payout_processing'
        )
        ORDER BY created_at ASC
        LIMIT 20
        `
      );

    for (
      const request of result.rows
    ) {
      await processPayment(request);
    }
  } catch (error) {
    console.error(
      "Worker error:",
      error
    );
  } finally {
    workerRunning = false;
  }
}

/*
 * API: relay configuration.
 */
app.get(
  "/api/config",
  (req, res) => {
    res.json({
      network: "TRON Mainnet",
      relayAddress: RELAY_ADDRESS,
      usdtContract: USDT_CONTRACT,
      decimals: USDT_DECIMALS,
      maxUsdt: MAX_USDT
    });
  }
);

/*
 * API: create payment request.
 */
app.post(
  "/api/requests",
  async (req, res) => {
    try {
      const {
        senderAddress,
        recipientAddress,
        amount
      } = req.body;

      if (
        !isValidTronAddress(
          senderAddress
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid sender address"
        });
      }

      if (
        !isValidTronAddress(
          recipientAddress
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid recipient address"
        });
      }

      if (
        senderAddress ===
        RELAY_ADDRESS
      ) {
        return res.status(400).json({
          error:
            "Sender cannot be the relay address"
        });
      }

      const amountRaw =
        amountToRaw(amount);

      const id =
        createId();

      const result =
        await pool.query(
          `
          INSERT INTO payment_requests (
            id,
            sender_address,
            recipient_address,
            amount_raw,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            'waiting'
          )
          RETURNING *
          `,
          [
            id,
            senderAddress,
            recipientAddress,
            amountRaw
          ]
        );

      const request =
        result.rows[0];

      res.status(201).json({
        id: request.id,
        status: request.status,
        relayAddress:
          RELAY_ADDRESS,
        amount:
          rawToAmount(
            request.amount_raw
          ),
        amountRaw:
          request.amount_raw,
        network:
          "TRON Mainnet",
        contract:
          USDT_CONTRACT
      });
    } catch (error) {
      console.error(error);

      res.status(400).json({
        error:
          error.message ||
          "Unable to create request"
      });
    }
  }
);

/*
 * API: payment status.
 */
app.get(
  "/api/requests/:id",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT *
          FROM payment_requests
          WHERE id = $1
          `,
          [req.params.id]
        );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error:
            "Payment request not found"
        });
      }

      const request =
        result.rows[0];

      res.json({
        id: request.id,
        status: request.status,
        senderAddress:
          request.sender_address,
        recipientAddress:
          request.recipient_address,
        amount:
          rawToAmount(
            request.amount_raw
          ),
        amountRaw:
          request.amount_raw,
        depositTxid:
          request.deposit_txid,
        payoutTxid:
          request.payout_txid,
        error:
          request.error_message,
        createdAt:
          request.created_at,
        updatedAt:
          request.updated_at
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Unable to retrieve request"
      });
    }
  }
);

/*
 * Health check.
 */
app.get(
  "/health",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      res.json({
        status: "ok",
        database: "connected",
        network:
          "TRON Mainnet",
        relayAddress:
          RELAY_ADDRESS
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        database:
          "disconnected"
      });
    }
  }
);

/*
 * Serve frontend.
 */
app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/*
 * Start application.
 */
async function start() {
  try {
    await initDatabase();

    const contract =
      await tronWeb
        .contract()
        .at(USDT_CONTRACT);

    if (!contract) {
      throw new Error(
        "Unable to load USDT contract"
      );
    }

    console.log(
      "USDT contract loaded successfully"
    );

    app.listen(
      PORT,
      () => {
        console.log(
          `Server listening on port ${PORT}`
        );

        console.log(
          `Relay address: ${RELAY_ADDRESS}`
        );
      }
    );

    setInterval(
      worker,
      POLL_INTERVAL_MS
    );

    worker();
  } catch (error) {
    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);
  }
}

start();

