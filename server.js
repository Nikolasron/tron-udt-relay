```javascript
'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { TronWeb } = require('tronweb');
const crypto = require('crypto');
const path = require('path');

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  express.json({
    limit: '20kb'
  })
);


/* ============================================================
   CONFIGURATION
   ============================================================ */

const PORT =
  Number(process.env.PORT || 10000);

const TRON_HOST =
  (process.env.TRON_HOST ||
    'https://api.trongrid.io').replace(/\/$/, '');

const TRONGRID_API_KEY =
  process.env.TRONGRID_API_KEY;

const PRIVATE_KEY =
  process.env.TRON_PRIVATE_KEY;

const DATABASE_URL =
  process.env.DATABASE_URL;

const USDT_CONTRACT =
  process.env.USDT_CONTRACT ||
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const USDT_DECIMALS =
  Number(process.env.USDT_DECIMALS || 6);

const MAX_USDT =
  process.env.MAX_USDT || '1000';

const FEE_LIMIT_SUN =
  Number(
    process.env.FEE_LIMIT_SUN ||
    100000000
  );

const POLL_INTERVAL_MS =
  Number(
    process.env.POLL_INTERVAL_MS ||
    10000
  );

const REQUEST_EXPIRY_MINUTES =
  Number(
    process.env.REQUEST_EXPIRY_MINUTES ||
    30
);


/* ============================================================
   STARTUP VALIDATION
   ============================================================ */

if (!PRIVATE_KEY) {
  throw new Error(
    'TRON_PRIVATE_KEY is missing'
  );
}

if (
  !/^[0-9a-fA-F]{64}$/.test(
    PRIVATE_KEY
  )
) {
  throw new Error(
    'TRON_PRIVATE_KEY must contain exactly 64 hexadecimal characters'
  );
}

if (!TRONGRID_API_KEY) {
  throw new Error(
    'TRONGRID_API_KEY is missing'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is missing'
  );
}


/* ============================================================
   TRONWEB
   ============================================================ */

const tronWeb =
  new TronWeb({
    fullHost: TRON_HOST,

    headers: {
      'TRON-PRO-API-KEY':
        TRONGRID_API_KEY
    },

    privateKey:
      PRIVATE_KEY
  });


/*
 * The relay address is derived from the
 * server-side signing key.
 *
 * Do NOT hardcode a different address here.
 */

const RELAY_ADDRESS =
  tronWeb.defaultAddress.base58;


/* ============================================================
   DATABASE
   ============================================================ */

const pool =
  new Pool({
    connectionString:
      DATABASE_URL,

    max: 10,

    ssl:
      process.env.NODE_ENV === 'production'
        ? {
            rejectUnauthorized: false
          }
        : false
  });


/* ============================================================
   RATE LIMITING
   ============================================================ */

const publicLimiter =
  rateLimit({
    windowMs:
      60 * 1000,

    limit:
      60,

    standardHeaders:
      'draft-8',

    legacyHeaders:
      false
  });


const createLimiter =
  rateLimit({
    windowMs:
      60 * 1000,

    limit:
      10,

    standardHeaders:
      'draft-8',

    legacyHeaders:
      false
  });


app.use(
  '/api/',
  publicLimiter
);


/* ============================================================
   DATABASE INITIALIZATION
   ============================================================ */

async function initializeDatabase() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (

      id TEXT PRIMARY KEY,

      sender_address TEXT NOT NULL,

      recipient_address TEXT NOT NULL,

      amount_raw NUMERIC(78,0) NOT NULL,

      status TEXT NOT NULL
        DEFAULT 'awaiting_deposit',

      deposit_txid TEXT UNIQUE,

      payout_txid TEXT UNIQUE,

      error_message TEXT,

      created_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      updated_at
        TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    payment_requests_status_idx

    ON payment_requests(status);
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    payment_requests_created_idx

    ON payment_requests(created_at);
  `);


  console.log(
    'PostgreSQL database initialized'
  );
}


/* ============================================================
   ADDRESS HELPERS
   ============================================================ */

function normalizeAddress(
  address
) {

  return String(
    address || ''
  ).trim();
}


function validAddress(
  address
) {

  return TronWeb.isAddress(
    address
  );
}


/* ============================================================
   USDT AMOUNT CONVERSION
   ============================================================ */

function amountToRaw(
  amount
) {

  const text =
    String(amount || '')
      .trim();


  /*
   * USDT has 6 decimals.
   */

  const regex =
    /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;


  if (!regex.test(text)) {

    throw new Error(
      'Invalid USDT amount'
    );
  }


  const parts =
    text.split('.');


  const whole =
    parts[0];


  const fraction =
    parts[1] || '';


  const padded =
    fraction.padEnd(
      USDT_DECIMALS,
      '0'
    );


  const raw =
    BigInt(whole) *
      (
        10n **
        BigInt(USDT_DECIMALS)
      ) +

    BigInt(
      padded || '0'
    );


  return raw;
}


function rawToAmount(
  raw
) {

  const value =
    BigInt(String(raw));


  const base =
    10n **
    BigInt(USDT_DECIMALS);


  const whole =
    value / base;


  const fraction =
    (
      value % base
    )
      .toString()
      .padStart(
        USDT_DECIMALS,
        '0'
      )
      .replace(
        /0+$/,
        ''
      );


  if (!fraction) {

    return String(
      whole
    );

  }


  return (
    String(whole) +
    '.' +
    fraction
  );
}


function maxAmountRaw() {

  return amountToRaw(
    MAX_USDT
  );
}


/* ============================================================
   API RESPONSE FORMAT
   ============================================================ */

function formatRequest(
  row
) {

  return {

    id:
      row.id,

    senderAddress:
      row.sender_address,

    recipientAddress:
      row.recipient_address,

    amount:
      rawToAmount(
        row.amount_raw
      ),

    status:
      row.status,

    depositTxid:
      row.deposit_txid,

    payoutTxid:
      row.payout_txid,

    error:
      row.error_message,

    createdAt:
      row.created_at,

    updatedAt:
      row.updated_at
  };
}


/* ============================================================
   TRONGRID REQUEST
   ============================================================ */

async function tronRequest(
  url,
  options = {}
) {

  const response =
    await fetch(
      url,
      {
        ...options,

        headers: {

          accept:
            'application/json',

          'TRON-PRO-API-KEY':
            TRONGRID_API_KEY,

          ...(options.headers || {})
        }
      }
    );


  const text =
    await response.text();


  let data;


  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    throw new Error(
      'Invalid response from TRON API'
    );

  }


  if (!response.ok) {

    throw new Error(
      `TRON API ${response.status}`
    );

  }


  return data;
}


/* ============================================================
   GET SOLIDIFIED TRANSACTION INFO
   ============================================================ */

async function getTransactionInfo(
  txid
) {

  const url =
    `${TRON_HOST}/walletsolidity/gettransactioninfobyid`;


  try {

    const data =
      await tronRequest(
        url,
        {
          method: 'POST',

          headers: {
            'content-type':
              'application/json'
          },

          body:
            JSON.stringify({
              value:
                txid
            })
        }
      );


    if (
      !data ||
      !data.id
    ) {

      return null;

    }


    return data;

  } catch {

    return null;

  }
}


/* ============================================================
   GET TRANSACTION EVENTS
   ============================================================ */

async function getTransactionEvents(
  txid
) {

  const url =
    `${TRON_HOST}/v1/transactions/` +
    encodeURIComponent(txid) +
    `/events?only_confirmed=true`;


  const data =
    await tronRequest(
      url
    );


  return Array.isArray(
    data.data
  )
    ? data.data
    : [];
}


/* ============================================================
   VERIFY TRC-20 TRANSFER
   ============================================================ */

async function verifyTransfer(
  txid,
  expectedFrom,
  expectedTo,
  expectedAmount
) {

  const receipt =
    await getTransactionInfo(
      txid
    );


  if (!receipt) {

    return {
      verified: false,
      reason:
        'Transaction is not solidified'
    };

  }


  /*
   * Verify smart-contract execution.
   */

  if (
    receipt.receipt &&
    receipt.receipt.result &&
    receipt.receipt.result !==
      'SUCCESS'
  ) {

    return {
      verified: false,
      reason:
        'Smart contract execution failed'
    };

  }


  const events =
    await getTransactionEvents(
      txid
    );


  const matchingEvent =
    events.find(
      event => {

        if (
          event.event_name !==
          'Transfer'
        ) {

          return false;

        }


        const contract =
          event.contract_address ||
          event.caller_contract_address;


        if (
          String(contract)
            .toLowerCase() !==
          USDT_CONTRACT.toLowerCase()
        ) {

          return false;

        }


        const result =
          event.result || {};


        const from =
          String(
            result.from || ''
          );


        const to =
          String(
            result.to || ''
          );


        const value =
          String(
            result.value || ''
          );


        return (

          from ===
          expectedFrom &&

          to ===
          expectedTo &&

          value ===
          String(
            expectedAmount
          )

        );

      }
    );


  if (!matchingEvent) {

    return {
      verified: false,
      reason:
        'Matching USDT Transfer event not found'
    };

  }


  return {

    verified: true,

    receipt,

    event:
      matchingEvent
  };
}


/* ============================================================
   FIND MATCHING DEPOSIT
   ============================================================ */

async function findDeposit(
  request
) {

  const created =
    new Date(
      request.created_at
    ).getTime();


  /*
   * Search slightly before request
   * creation time to tolerate clock/indexing
   * differences.
   */

  const minimumTimestamp =
    created -
    5 * 60 * 1000;


  const params =
    new URLSearchParams({

      limit:
        '200',

      only_confirmed:
        'true',

      only_to:
        'true',

      contract_address:
        USDT_CONTRACT,

      min_timestamp:
        String(
          minimumTimestamp
        ),

      order_by:
        'block_timestamp,desc'
    });


  const url =
    `${TRON_HOST}/v1/accounts/` +
    encodeURIComponent(
      RELAY_ADDRESS
    ) +
    `/transactions/trc20?` +
    params.toString();


  const response =
    await tronRequest(
      url
    );


  const transfers =
    Array.isArray(
      response.data
    )
      ? response.data
      : [];


  const expectedAmount =
    String(
      request.amount_raw
    );


  for (
    const tx
    of transfers
  ) {

    if (
      tx.type !==
      'Transfer'
    ) {

      continue;

    }


    /*
     * Verify token contract.
     */

    if (
      String(
        tx.token_info?.address || ''
      ).toLowerCase() !==
      USDT_CONTRACT.toLowerCase()
    ) {

      continue;

    }


    /*
     * Verify sender.
     */

    if (
      tx.from !==
      request.sender_address
    ) {

      continue;

    }


    /*
     * Verify relay address.
     */

    if (
      tx.to !==
      RELAY_ADDRESS
    ) {

      continue;

    }


    /*
     * Verify exact amount.
     */

    if (
      String(tx.value) !==
      expectedAmount
    ) {

      continue;

    }


    /*
     * Verify the actual Transfer event.
     */

    const verification =
      await verifyTransfer(

        tx.transaction_id,

        request.sender_address,

        RELAY_ADDRESS,

        expectedAmount

      );


    if (
      !verification.verified
    ) {

      continue;

    }


    return tx;

  }


  return null;
}


/* ============================================================
   BROADCAST USDT PAYOUT
   ============================================================ */

async function sendUSDT(
  recipient,
  amountRaw
) {

  if (
    !validAddress(
      recipient
    )
  ) {

    throw new Error(
      'Invalid recipient address'
    );

  }


  const contract =
    await tronWeb
      .contract()
      .at(
        USDT_CONTRACT
      );


  /*
   * The private key configured on the
   * server is used here by TronWeb.
   *
   * It never reaches the browser.
   */

  const result =
    await contract
      .transfer(
        recipient,
        String(
          amountRaw
        )
      )
      .send({

        feeLimit:
          FEE_LIMIT_SUN,

        callValue:
          0,

        shouldPollResponse:
          false
      });


  if (!result) {

    throw new Error(
      'No payout transaction ID returned'
    );

  }


  return Array.isArray(result)
    ? result[0]
    : result;
}


/* ============================================================
   PROCESS PAYMENT
   ============================================================ */

async function processPayment(
  request
) {

  try {

    /*
     * --------------------------------------------------------
     * EXPIRE OLD REQUEST
     * --------------------------------------------------------
     */

    if (
      request.status ===
      'awaiting_deposit'
    ) {

      const age =
        Date.now() -
        new Date(
          request.created_at
        ).getTime();


      if (
        age >
        REQUEST_EXPIRY_MINUTES *
        60 *
        1000
      ) {

        await pool.query(
          `
          UPDATE payment_requests

          SET
            status = 'expired',
            updated_at = NOW()

          WHERE
            id = $1

            AND status =
              'awaiting_deposit'
          `,
          [
            request.id
          ]
        );


        return;

      }

    }


    /*
     * --------------------------------------------------------
     * FIND DEPOSIT
     * --------------------------------------------------------
     */

    if (
      request.status ===
      'awaiting_deposit'
    ) {

      const deposit =
        await findDeposit(
          request
        );


      if (!deposit) {

        return;

      }


      /*
       * Claim deposit atomically.
       *
       * Unique deposit_txid prevents reuse.
       */

      const claim =
        await pool.query(
          `
          UPDATE payment_requests

          SET
            status =
              'payout_pending',

            deposit_txid =
              $2,

            updated_at =
              NOW()

          WHERE
            id = $1

            AND status =
              'awaiting_deposit'

            AND deposit_txid IS NULL

          RETURNING *
          `,
          [
            request.id,

            deposit.transaction_id
          ]
        );


      if (
        !claim.rowCount
      ) {

        return;

      }


      request =
        claim.rows[0];

    }


    /*
     * --------------------------------------------------------
     * PAYOUT PENDING
     * --------------------------------------------------------
     */

    if (
      request.status ===
      'payout_pending'
    ) {

      /*
       * Make sure another worker hasn't
       * already created the payout.
       */

      const locked =
        await pool.query(
          `
          UPDATE payment_requests

          SET
            updated_at =
              NOW()

          WHERE
            id = $1

            AND status =
              'payout_pending'

            AND payout_txid IS NULL

          RETURNING *
          `,
          [
            request.id
          ]
        );


      if (
        !locked.rowCount
      ) {

        return;

      }


      request =
        locked.rows[0];


      /*
       * Broadcast payout.
       */

      const payoutTxid =
        await sendUSDT(
          request.recipient_address,

          request.amount_raw
        );


      /*
       * Save payout transaction.
       */

      await pool.query(
        `
        UPDATE payment_requests

        SET
          payout_txid =
            $2,

          status =
            'payout_broadcast',

          updated_at =
            NOW(),

          error_message =
            NULL

        WHERE
          id = $1

          AND status =
            'payout_pending'

          AND payout_txid IS NULL
        `,
        [
          request.id,

          payoutTxid
        ]
      );


      console.log(
        'Payout broadcast:',
        payoutTxid
      );


      return;

    }


    /*
     * --------------------------------------------------------
     * VERIFY BROADCAST PAYOUT
     * --------------------------------------------------------
     */

    if (
      request.status ===
      'payout_broadcast'
      &&
      request.payout_txid
    ) {

      const verification =
        await verifyTransfer(

          request.payout_txid,

          RELAY_ADDRESS,

          request.recipient_address,

          request.amount_raw

        );


      if (
        !verification.verified
      ) {

        return;

      }


      await pool.query(
        `
        UPDATE payment_requests

        SET
          status =
            'completed',

          updated_at =
            NOW(),

          error_message =
            NULL

        WHERE
          id = $1

          AND status =
            'payout_broadcast'
        `,
        [
          request.id
        ]
      );


      console.log(
        'Payment completed:',
        request.id
      );

    }

  } catch (error) {

    console.error(
      'Payment processing error:',
      request.id,
      error.message
    );


    await pool.query(
      `
      UPDATE payment_requests

      SET
        error_message =
          $2,

        updated_at =
          NOW()

      WHERE
        id = $1
      `,
      [
        request.id,

        String(
          error.message
        ).slice(
          0,
          1000
        )
      ]
    );

  }
}


/* ============================================================
   WORKER
   ============================================================ */

let workerRunning =
  false;


async function worker() {

  if (workerRunning) {
    return;
  }


  workerRunning =
    true;


  try {

    /*
     * First check payouts that were
     * already broadcast.
     */

    const broadcast =
      await pool.query(
        `
        SELECT *

        FROM payment_requests

        WHERE
          status =
            'payout_broadcast'

        ORDER BY
          created_at ASC

        LIMIT 25
        `
      );


    for (
      const request
      of broadcast.rows
    ) {

      await processPayment(
        request
      );

    }


    /*
     * Then check new deposits.
     */

    const waiting =
      await pool.query(
        `
        SELECT *

        FROM payment_requests

        WHERE
          status =
            'awaiting_deposit'

        ORDER BY
          created_at ASC

        LIMIT 25
        `
      );


    for (
      const request
      of waiting.rows
    ) {

      await processPayment(
        request
      );

    }


    /*
     * Finally process verified deposits
     * waiting for payout.
     */

    const payoutPending =
      await pool.query(
        `
        SELECT *

        FROM payment_requests

        WHERE
          status =
            'payout_pending'

        ORDER BY
          created_at ASC

        LIMIT 25
        `
      );


    for (
      const request
      of payoutPending.rows
    ) {

      await processPayment(
        request
      );

    }

  } catch (error) {

    console.error(
      'Worker error:',
      error.message
    );

  } finally {

    workerRunning =
      false;

  }

}


/* ============================================================
   API: CONFIGURATION
   ============================================================ */

app.get(
  '/api/config',
  async (req, res) => {

    res.json({

      network:
        'TRON Mainnet',

      token:
        'USDT',

      tokenStandard:
        'TRC-20',

      contract:
        USDT_CONTRACT,

      decimals:
        USDT_DECIMALS,

      relayAddress:
        RELAY_ADDRESS,

      maxUSDT:
        MAX_USDT
    });

  }
);


/* ============================================================
   API: CREATE PAYMENT REQUEST
   ============================================================ */

app.post(
  '/api/requests',
  createLimiter,
  async (req, res) => {

    try {

      const sender =
        normalizeAddress(
          req.body.senderAddress
        );


      const recipient =
        normalizeAddress(
          req.body.recipientAddress
        );


      const amount =
        String(
          req.body.amount || ''
        ).trim();


      /*
       * Validate addresses.
       */

      if (
        !validAddress(
          sender
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              'Invalid sender TRON address'
          });

      }


      if (
        !validAddress(
          recipient
        )
      ) {

        return res
          .status(400)
          .json({
            error:
              'Invalid recipient TRON address'
          });

      }


      /*
       * Do not allow relay-to-relay.
       */

      if (
        recipient ===
        RELAY_ADDRESS
      ) {

        return res
          .status(400)
          .json({
            error:
              'Recipient cannot be the relay address'
          });

      }


      /*
       * Do not allow same sender/recipient.
       */

      if (
        sender ===
        recipient
      ) {

        return res
          .status(400)
          .json({
            error:
              'Sender and recipient must be different'
          });

      }


      /*
       * Convert amount safely.
       */

      const rawAmount =
        amountToRaw(
          amount
        );


      if (
        rawAmount <= 0n
      ) {

        return res
          .status(400)
          .json({
            error:
              'Amount must be greater than zero'
          });

      }


      /*
       * Enforce maximum.
       */

      if (
        rawAmount >
        maxAmountRaw()
      ) {

        return res
          .status(400)
          .json({
            error:
              `Maximum amount is ${MAX_USDT} USDT`
          });

      }


      /*
       * Generate request ID.
       */

      const id =
        crypto.randomUUID();


      /*
       * Store request.
       */

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
            'awaiting_deposit'
          )

          RETURNING *
          `,
          [
            id,

            sender,

            recipient,

            rawAmount.toString()
          ]
        );


      res
        .status(201)
        .json(
          formatRequest(
            result.rows[0]
          )
        );


    } catch (error) {

      console.error(
        'Create request error:',
        error.message
      );


      res
        .status(400)
        .json({
          error:
            error.message ||
            'Invalid payment request'
        });

    }

  }
);


/* ============================================================
   API: PAYMENT STATUS
   ============================================================ */

app.get(
  '/api/requests/:id',
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT *

          FROM payment_requests

          WHERE
            id = $1
          `,
          [
            req.params.id
          ]
        );


      if (
        !result.rowCount
      ) {

        return res
          .status(404)
          .json({
            error:
              'Payment request not found'
          });

      }


      res.json(
        formatRequest(
          result.rows[0]
        )
      );


    } catch (error) {

      console.error(
        'Status error:',
        error.message
      );


      res
        .status(500)
        .json({
          error:
            'Server error'
        });

    }

  }
);


/* ============================================================
   HEALTH CHECK
   ============================================================ */

app.get(
  '/health',
  async (req, res) => {

    try {

      await pool.query(
        'SELECT 1'
      );


      res.json({

        ok:
          true,

        network:
          'TRON Mainnet',

        token:
          'USDT TRC-20',

        relayAddress:
          RELAY_ADDRESS
      });


    } catch {

      res
        .status(503)
        .json({
          ok:
            false
        });

    }

  }
);


/* ============================================================
   STATIC WEBSITE
   ============================================================ */

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);


/* ============================================================
   START SERVER
   ============================================================ */

async function start() {

  await initializeDatabase();


  /*
   * Confirm the configured contract.
   */

  const contract =
    await tronWeb
      .contract()
      .at(
        USDT_CONTRACT
      );


  const symbol =
    await contract
      .symbol()
      .call();


  const decimals =
    await contract
      .decimals()
      .call();


  console.log(
    '================================'
  );

  console.log(
    'TRON USDT RELAY'
  );

  console.log(
    'Network: TRON Mainnet'
  );

  console.log(
    'Token:',
    String(symbol)
  );

  console.log(
    'Decimals:',
    String(decimals)
  );

  console.log(
    'USDT Contract:',
    USDT_CONTRACT
  );

  console.log(
    'Relay Address:',
    RELAY_ADDRESS
  );

  console.log(
    '================================'
  );


  /*
   * Make sure this really is USDT.
   */

  if (
    String(symbol)
      .toUpperCase() !==
    'USDT'
  ) {

    throw new Error(
      `Configured contract returned symbol ${symbol}, not USDT`
    );

  }


  if (
    Number(decimals) !==
    USDT_DECIMALS
  ) {

    throw new Error(
      `Expected ${USDT_DECIMALS} decimals, contract reports ${decimals}`
    );

  }


  app.listen(
    PORT,
    () => {

      console.log(
        `Server listening on port ${PORT}`
      );

    }
  );


  /*
   * Start blockchain worker.
   */

  setInterval(
    worker,
    POLL_INTERVAL_MS
  );


  /*
   * Run immediately.
   */

  await worker();

}


start()
  .catch(
    error => {

      console.error(
        'FATAL STARTUP ERROR'
      );

      console.error(
        error
      );

      process.exit(1);

    }
  );
```
