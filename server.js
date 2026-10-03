<script>
"use strict";

let currentRequestId = null;
let pollTimer = null;

/* ---------- ELEMENTS ---------- */

const senderInput     = document.getElementById("sender");
const recipientInput  = document.getElementById("recipient");
const amountInput     = document.getElementById("amount");
const relayAddressBox = document.getElementById("relayAddress");
const relayShortBox   = document.getElementById("relayShort");
const contractBox     = document.getElementById("contract");
const decimalsBox     = document.getElementById("decimals");
const maximumBox      = document.getElementById("maximum");
const statusBox       = document.getElementById("status");
const createButton    = document.getElementById("createButton");


/* ---------- HELPER FUNCTIONS ---------- */

function setStatus(message, type = "") {
  statusBox.className = "status";
  if (type) statusBox.classList.add(type);
  statusBox.textContent = message;
}

function formatAddress(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}


/* ---------- LOAD SERVER CONFIGURATION ---------- */

async function loadConfig() {
  try {
    const response = await fetch("/api/config", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    const text = await response.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Server did not return valid JSON.");
    }

    if (!response.ok) {
      throw new Error(data.error || "Server returned HTTP " + response.status);
    }

    const relayAddr = data.relayAddress || "Unavailable";
    relayAddressBox.textContent = relayAddr;
    relayShortBox.textContent   = formatAddress(relayAddr);

    contractBox.textContent = data.usdtContract || "Unavailable";
    decimalsBox.textContent = data.decimals !== undefined ? data.decimals : "6";
    maximumBox.textContent  = data.maxUsdt !== undefined ? data.maxUsdt : "Unavailable";

    setStatus("Server configuration loaded successfully.", "success");

  } catch (error) {
    console.error("[config] Error:", error);

    relayAddressBox.textContent = "ERROR: " + error.message;
    relayShortBox.textContent   = "ERROR";
    contractBox.textContent     = "ERROR";
    maximumBox.textContent      = "ERROR";

    setStatus(
      "Unable to connect to the relay server.\n\n" + error.message,
      "error"
    );
  }
}


/* ---------- COPY RELAY ADDRESS ---------- */

async function copyRelayAddress() {
  const address = relayAddressBox.textContent.trim();

  if (
    !address ||
    address === "Loading relay address..." ||
    address === "Unavailable" ||
    address.startsWith("ERROR")
  ) return;

  try {
    await navigator.clipboard.writeText(address);
    setStatus("Relay address copied to clipboard.", "success");
  } catch {
    setStatus("Could not copy automatically. Please copy manually.");
  }
}


/* ---------- CREATE PAYMENT REQUEST ---------- */

async function createRequest() {
  const sender    = senderInput.value.trim();
  const recipient = recipientInput.value.trim();
  const amount    = amountInput.value.trim();

  if (!sender)    { setStatus("Enter the sender TRON address.", "error");    senderInput.focus();    return; }
  if (!recipient) { setStatus("Enter the recipient TRON address.", "error"); recipientInput.focus(); return; }
  if (!amount)    { setStatus("Enter the USDT amount.", "error");            amountInput.focus();    return; }

  if (sender.toLowerCase() === recipient.toLowerCase()) {
    setStatus("Sender and recipient must be different.", "error");
    return;
  }

  createButton.disabled = true;
  setStatus("Creating payment request...");

  try {
    const response = await fetch("/api/requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        senderAddress: sender,
        recipientAddress: recipient,
        amount: amount
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "The server rejected the request.");
    }

    currentRequestId = data.id;

    setStatus(
      "PAYMENT REQUEST CREATED\n\n" +
      "Request ID:\n" + data.id +
      "\n\nAmount:\n" + data.amount + " USDT" +
      "\n\nSend exactly:\n" + data.amount + " USDT TRC-20" +
      "\n\nTo:\n" + relayAddressBox.textContent +
      "\n\nCurrent status:\n" + data.status +
      "\n\nWaiting for the blockchain deposit..."
    );

    startPolling();

  } catch (error) {
    setStatus("ERROR\n\n" + error.message, "error");
  } finally {
    createButton.disabled = false;
  }
}


/* ---------- POLLING ---------- */

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollStatus();
  pollTimer = setInterval(pollStatus, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStatus() {
  if (!currentRequestId) return;

  try {
    const response = await fetch(
      "/api/requests/" + encodeURIComponent(currentRequestId),
      { method: "GET", headers: { "Accept": "application/json" } }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to retrieve payment status.");
    }

    let message = "PAYMENT REQUEST\n\n";
    message += "Request ID:\n" + data.id + "\n\n";
    message += "Amount:\n" + data.amount + " USDT\n\n";
    message += "Status:\n" + data.status + "\n\n";

    if (data.depositTxid) message += "Deposit TX:\n" + data.depositTxid + "\n\n";
    if (data.payoutTxid)  message += "Payout TX:\n"  + data.payoutTxid  + "\n\n";
    if (data.error)       message += "Server message:\n" + data.error + "\n\n";

    // Aligned to backend status enums:
    // 'waiting' | 'deposit_confirmed' | 'payout_processing' | 'completed' | 'failed' | 'expired'
    if (data.status === "waiting") {
      message += "Waiting for confirmed USDT deposit on-chain...";
    } else if (data.status === "deposit_confirmed") {
      message += "Deposit verified!\nPreparing recipient payout...";
    } else if (data.status === "payout_processing") {
      message += "Payout processing on TRON network...";
    } else if (data.status === "completed") {
      message += "COMPLETED\n\nThe USDT payout has been verified on-chain.";
      stopPolling();
    } else if (data.status === "failed") {
      message += "FAILED\n\nPayout failed. See server message above.";
      stopPolling();
    } else if (data.status === "expired") {
      message += "EXPIRED\n\nThis request expired before a deposit arrived.";
      stopPolling();
    }

    const alertType = data.status === "completed" ? "success" : (data.status === "failed" ? "error" : "");
    setStatus(message, alertType);

  } catch (error) {
    setStatus("Payment status temporarily unavailable.\n\n" + error.message, "warning");
  }
}


/* ---------- INITIALIZE ---------- */

loadConfig();
</script>
