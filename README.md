<p align="center">
  <img src="logo.png" width="120" alt="CSM Logo"/>
</p>
<h1 align="center"> Lido Staking Module Prover Tool </h1>

## Description

Tool for reporting bad performers, withdrawals, slashings, and balance changes for Lido Community Staking-like modules (`CSM`, `Curated Module`)

### Build steps (for development)

```bash
# Deps
$ nvm install && nvm use
$ corepack enable && corepack use yarn@4.12.0
$ yarn install --immutable
# Build
$ yarn build
```

### Daemon working mode

The tool is a daemon that listens to the CL and EL and reports bad performers, withdrawals, slashings, and balance changes to Lido Community Staking-like modules (`CSM`, `Curated Module`).

<details>
  <summary>The algorithm is as follows</summary>


0. Get the current CL finalized head.
1. Get the current validator set of the CS Module.
   > It is necessary at the first startup. All subsequent runs of the indexer will be performed when necessary and independently of the main processing
2. Choose the next block service to process.
   > The provider chooses the next root with the following priority:
   > - Return the oldest root from the roots stack once the keys indexer covers its slot
   > - *When no any processed roots yet* Return `START_ROOT` or the last finalized root if `START_ROOT` is not set
   > - Return a finalized child root of the last processed root
   > - Rewind `ROOTS_ORPHAN_REWIND_EPOCHS` epochs back to a canonical finalized block if the last processed root is not confirmed on the finalized chain (e.g. reorged out)
   > - Sleep 12s if nothing to process and **return to the step 0**
3. Process the root.
   > The processor does the following:
   > - Get the block info from CL by the root
   > - Add the root to the roots stack
   > - If the block has a slashing or withdrawal, report it to the CS Module
   > - At the first block of each epoch, check and report additional balance changes
   > - Remove the root from the roots stack if the keys indexer knows every validator the block references
4. Build and send proofs to the CS Module contract when reportable events are found.

So, according to the algorithm, there are the following statements:
1. We always go sequentially by the finalized roots of blocks, taking the next one by the root of the previous one. In this way, we avoid missing any blocks.
2. If for some reason the daemon crashes, it will start from the last root running before the crash when it is launched
3. If the keys indexer lags behind (EL or CL node failures), roots are still processed with the last indexed keys: new validators can't be slashed for ~15h or withdrawn for ~27h after they appear (`MIN_VALIDATOR_WITHDRAWABILITY_DELAY`). A root whose block references a validator unknown to the indexer stays in the roots stack and is processed again once the indexer catches up.

</details>

#### How to run

1. Copy `.env.example` to `.env` and fill in the necessary fields

   ```bash
   $ cp .env.example .env
   ```
2. Run the daemon:

   a. Using the docker compose

   ```bash
   $ docker-compose up -d daemon
   ```

   b. Or using yarn
    
   ```bash
   $ yarn run start:prod
   ```

### CLI working mode

#### How to run

1. Copy `.env.example` to `.env` and fill in the necessary fields

   ```bash
   $ cp .env.example .env
   ```

2. Run the CLI:

   a. Using the docker compose

   ```bash
   # Report withdrawal
   $ docker compose run -it --rm withdrawal
   # Report bad performer ejection
   $ docker compose run -it --rm bad_performer
   ```

   b. Or using yarn

   ```bash
   # Report slashing
   $ yarn slashing
   # Report withdrawal
   $ yarn withdrawal
   # Report bad performer ejection
   $ yarn bad_performer
   # Report balance change
   $ yarn balance
   ```

   c. Generic CLI entrypoint (all proof modes)

   ```bash
   $ yarn prove <slashing|withdrawal|bad_performer|balance> \
     --node-operator-id <id> \
     --key-index <index> \
     --validator-index <index> \
     --cl-block <slot-or-root>
   ```

#### Options to run CLI

`--node-operator-id ` - Node operator ID

`--key-index` - Key index in the CSM module according to Node Operator

`--validator-index` - Validator index in the Consensus Layer

`--cl-block` - Consensus Layer block reference (slot or block root) used as proof context

`--help` - Show help

## Environment variables

| Name                                    | Description                                                             | Required               | Default                       |
|-----------------------------------------|-------------------------------------------------------------------------|------------------------|-------------------------------|
| WORKING_MODE                            | Working mode of the tool (`daemon` or `cli`)                            | no                     | daemon                        |
| DRY_RUN                                 | Prepare and emulate transactions without sending them                   | no                     | false                         |
| CHAIN_ID                                | EL chain ID (1 — Mainnet, 17000 — Holesky)                              | yes                    |                               |
| EL_RPC_URLS                             | Comma-separated list of EL RPC URLs                                     | yes                    |                               |
| EL_RPC_RETRY_DELAY_MS                   | Delay between EL RPC retries in milliseconds                            | no                     | 500                           |
| EL_RPC_MAX_RETRIES                      | Maximum number of EL RPC retries                                        | no                     | 3                             |
| EL_RPC_RESET_INTERVAL_MS                | Reset active EL provider if no requests within this interval            | no                     | 720_000 (12 min)              |
| EL_RPC_MAX_BATCH_SIZE                   | Max JSON-RPC calls coalesced into one batched HTTP request             | no                     | 25                            |
| EL_RPC_MAX_CONCURRENT_REQUESTS          | Max concurrent batched HTTP requests in flight to a single EL provider | no                     | 2                             |
| EL_RPC_BATCH_AGGREGATION_WAIT_MS        | Window (ms) to accumulate calls into a batch before sending            | no                     | 10                            |
| CL_API_URLS                             | Comma-separated list of CL API URLs                                     | yes                    |                               |
| CL_API_RETRY_DELAY_MS                   | Delay between CL API retries in milliseconds                            | no                     | 500                           |
| CL_API_RESPONSE_TIMEOUT_MS              | CL API response timeout in milliseconds                                 | no                     | 60_000                        |
| CL_API_MAX_RETRIES                      | Maximum number of CL API retries                                        | no                     | 3                             |
| START_ROOT                              | Start CL block root for the daemon (defaults to current finalized root) | no                     |                               |
| HTTP_USER_AGENT                         | `User-Agent` for all outgoing requests. Empty string — send none        | no                     | `csm-prover-tool/<version>`   |
| ROOTS_PROCESSING_LAG_SLOTS              | Min slot-distance between processing tip and finalized tip. 0 = off     | no                     | 0                             |
| ROOTS_ORPHAN_REWIND_EPOCHS              | Epochs to rewind when the last processed root is not confirmed on the finalized chain | no                     | 1                             |
| DAEMON_NODE_OPERATOR_IDS                | Comma-separated node operator IDs to index and prove (daemon mode only); all if unset | no                     |                               |
| STAKING_MODULE_ADDRESS                  | Address of the staking module contract                                  | yes                    |                               |
| VERIFIER_ADDRESS                        | Address of the verifier contract                                        | no                     |                               |
| STRIKES_ADDRESS                         | Address of the strikes contract                                         | no                     |                               |
| EXIT_PENALTIES_ADDRESS                  | Address of the exit penalties contract                                  | no                     |                               |
| TX_SIGNER_PRIVATE_KEY                   | Private key of the transaction signer                                   | yes (if not dry run)   |                               |
| TX_MIN_GAS_PRIORITY_FEE                 | Minimum gas priority fee (wei)                                          | no                     | 50_000_000 (0.05 gwei)        |
| TX_MAX_GAS_PRIORITY_FEE                 | Maximum gas priority fee (wei)                                          | no                     | 10_000_000_000 (10 gwei)      |
| TX_GAS_PRIORITY_FEE_PERCENTILE          | Percentile of recent priority fees used as the target                   | no                     | 25                            |
| TX_GAS_FEE_HISTORY_DAYS                 | Days of base fee history used for gas acceptance check                  | no                     | 1                             |
| TX_GAS_FEE_HISTORY_PERCENTILE           | Percentile of base fee history used for gas acceptance check            | no                     | 50                            |
| TX_MIN_BASE_FEE_GWEI                    | Base fee floor (gwei); tx sent at once below it. 0 = disabled            | no                     | 1                             |
| TX_MAX_BASE_FEE_GWEI                    | Absolute base fee ceiling (gwei); tx held back above it. 0 = disabled    | no                     | 50                            |
| TX_GAS_LIMIT                            | Hard cap on transaction gas limit                                       | no                     | 2_000_000                     |
| TX_GAS_LIMIT_BUFFER_PERCENT             | Safety buffer added on top of `estimateGas` result (percent)            | no                     | 20                            |
| TX_HIGH_GAS_FEE_MAX_RETRIES             | Max retries when gas fee is too high before giving up                   | no                     | 13                            |
| TX_HIGH_GAS_FEE_RETRY_DELAY_MS          | Delay between high-gas-fee retries in milliseconds                      | no                     | 60_000                        |
| TX_MINING_WAITING_TIMEOUT_MS            | Timeout for waiting for transaction mining confirmation                 | no                     | 180_000 (3 min)               |
| TX_CONFIRMATIONS                        | Number of block confirmations required after mining                     | no                     | 1                             |
| TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE       | Max number of strikes packed into a single transaction                  | no                     | 10                            |
| STRIKES_MAX_REQUEST_FEE_GWEI            | Abort bad-performance proof if EIP-7002 withdrawal request fee ≥ this    | no                     | 6000                          |
| WORKER_TIMEOUT_MS                       | Timeout before a proof worker is forcibly terminated                    | no                     | 1_800_000 (30 min)            |
| BALANCE_PROOF_MIN_DELTA_GWEI            | Minimum balance increase above confirmed level to trigger a proof       | no                     | 512_000_000_000 (512 ETH)     |
| BALANCE_PROOF_TOPUP_STEP_GWEI           | Report a balance change this far below MaxEB (top-up step); 0 = at MaxEB | no                     | 2_000_000_000 (2 ETH)         |
| KEYS_INDEXER_RUNNING_PERIOD_MS          | How often the keys indexer checks finalized EL keys and CL validators  | no                     | 10_800_000 (3 hours)          |
| HTTP_PORT                               | Port for the metrics/health HTTP server                                 | no                     | 8080                          |
| LOG_LEVEL                               | Log level (`error`, `warn`, `info`, `debug`)                            | no                     | info                          |
| LOG_FORMAT                              | Log format (`simple` or `json`)                                         | no                     | simple                        |

> Adding an operator that already has validators to `DAEMON_NODE_OPERATOR_IDS`: delete `keys-indexer-info.json` and `keys-indexer-storage.json` from the module storage directory and restart, otherwise its existing validators are not indexed.

> [!NOTE]
> Outgoing requests are identified as `csm-prover-tool/<version>` so that node operators and RPC
> providers can attribute traffic instead of rate-limiting an anonymous client. Set `HTTP_USER_AGENT=`
> (empty) if you prefer not to advertise to a third-party endpoint that you run a CSM prover.

### Running a backup instance

A second daemon must run as a standby. Two instances on the same root broadcast the same proof: the loser
pays gas for a revert and, for bad-performance reports, another EIP-7002 fee and a slot of the shared exit quota.

- `ROOTS_PROCESSING_LAG_SLOTS` — `0` on the primary, `150` (~30 min) on the backup. It must outlast the
  primary's transaction path, ~16 min on defaults
  (`TX_HIGH_GAS_FEE_MAX_RETRIES * TX_HIGH_GAS_FEE_RETRY_DELAY_MS + TX_MINING_WAITING_TIMEOUT_MS`).
- `TX_SIGNER_PRIVATE_KEY` — one key per instance, otherwise both populate the same nonce.
- Storage — one volume per instance; `storage/<STAKING_MODULE_ADDRESS>/` holds the checkpoint and index.
- First start — the lag gate is skipped while there is no checkpoint, so set `START_ROOT` behind the tip.

## Test

```bash
# unit tests
$ yarn run test

# e2e daemon tests
$ yarn run test-daemon

# e2e cli tests
$ yarn run test-cli

# test coverage
$ yarn run test:cov
```

## Linter

```bash
# check
$ yarn run lint

# fix
$ yarn run lint:fix
```
