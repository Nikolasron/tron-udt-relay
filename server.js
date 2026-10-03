require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// In-memory store for requests (Replace with PostgreSQL database queries in production)
const requestsStore = new Map();

// Parse JSON request bodies
app.use(express.json());

// Serve static frontend UI files from the public folder
app.use(express.static(path.join(__dirname, "public")));

// API: Config Endpoint
app.get("/api/config", (req, res) => {
  res.json({
    relayAddress: process.env.RELAY_ADDRESS || "TYourRelayAddressHere...",
    usdtContract: process.env.USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    maxUsdt: process.env.MAX_USDT || "1000"
  });
});

// API: Create Payment Request Endpoint
app.post("/api/requests", (req, res) => {
  const { senderAddress, recipientAddress, amount } = req.body;

  if (!senderAddress || !recipientAddress || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const id = "req_" + Math.random().toString(36).substring(2, 10);
  const newRequest = {
    id,
    senderAddress,
    recipientAddress,
    amount,
    status: "waiting", // options: waiting, deposit_confirmed, payout_processing, completed, failed
    createdAt: new Date()
  };

  requestsStore.set(id, newRequest);
  return res.status(201).json(newRequest);
});

// API: Get Payment Status Endpoint
app.get("/api/requests/:id", (req, res) => {
  const requestId = req.params.id;
  const request = requestsStore.get(requestId);

  if (!request) {
    return res.status(404).json({ error: "Payment request not found" });
  }

  return res.json(request);
});

// Fallback to send index.html for UI routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
