# Access via x402 Payments (in Solana network)

Pay‑per‑query access to Solana transaction & token activity using the x402 protocol.

Payment is recieved in `USDC` (Solana chain)

## Endpoint

- Send an HTTP POST request to the x402 endpoint — https://pay402.onchaindivers.com/query
- Pricing: displayed in the 402 Payment Required response

## How it works?

1. You send an SQL query to the endpoint.
2. The service checks whether it has already been paid for.
3. If not, it responds with a payment request showing the amount due.
4. After the payment is completed and verified, the query runs automatically and you receive the results in JSON format.

## Who is it for?

This Indexer update is especially useful for AI agents and automated applications that can perform data queries and handle payments programmatically via x402 — enabling fully autonomous interaction with the Indexer.

## How we ran it:


```
npm install
npm run dev
```

```
runs on our http://localhost:3017
but outside available at https://pay402.onchaindivers.com/query
```