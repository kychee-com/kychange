# kychange

A swap desk between the two rails x402 settles on, USDC on Base and sats on Bitcoin Lightning, built as a [Run402](https://run402.com) application. Pay one rail, receive the other. The desk quotes from a hedge venue plus a spread and back-to-backs each fill there.

Status: design. See [docs/architecture.md](docs/architecture.md).

Run402 never holds the funds on either leg. Whoever deploys this holds the inventory, is the counterparty on every swap, and carries whatever obligations operating it with real money brings in their jurisdiction. Kychee publishes the code and runs a testnet-only instance at kychange.com.
