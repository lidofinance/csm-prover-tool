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
   > - Return the root from roots stack if exists and keys indexer is healthy enough to be trusted completely to process this root
   > - *When no any processed roots yet* Return `START_ROOT` or the last finalized root if `START_ROOT` is not set
   > - Return a finalized child root of the last processed root
   > - Sleep 12s if nothing to process and **return to the step 0**
3. Process the root.
   > The processor does the following:
   > - Get the block info from CL by the root
   > - If the current state of keys indexer is outdated (~15-27h behind from the block) to be trusted completely, add the block root to roots stack
   > - If the block has a slashing or withdrawal, report it to the CS Module
   > - At the first block of each epoch, check and report additional balance changes
   > - If the current state of keys indexer is healthy enough to be trusted completely, remove the root from roots stack
4. Build and send proofs to the CS Module contract when reportable events are found.

So, according to the algorithm, there are the following statements:
1. We always go sequentially by the finalized roots of blocks, taking the next one by the root of the previous one. In this way, we avoid missing any blocks.
2. If for some reason the daemon crashes, it will start from the last root running before the crash when it is launched
3. If for some reason KeysAPI crashed or CL node stopped giving validators, we can use the previously successfully received data to guarantee that our slashings will report for another ~15h and withdrawals for ~27h (because of the new validators appearing time and `MIN_VALIDATOR_WITHDRAWABILITY_DELAY`)
   If any of these time thresholds are breached, we cannot guarantee the correct key ownership determination. That's why we put the root block in the stack just in case, to process it again later when KeysAPI and CL node are well.

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
| CL_API_URLS                             | Comma-separated list of CL API URLs                                     | yes                    |                               |
| CL_API_RETRY_DELAY_MS                   | Delay between CL API retries in milliseconds                            | no                     | 500                           |
| CL_API_RESPONSE_TIMEOUT_MS              | CL API response timeout in milliseconds                                 | no                     | 60_000                        |
| CL_API_MAX_RETRIES                      | Maximum number of CL API retries                                        | no                     | 3                             |
| KEYSAPI_API_URLS                        | Comma-separated list of KeysAPI URLs                                    | yes (daemon mode only) |                               |
| KEYSAPI_API_RETRY_DELAY_MS              | Delay between KeysAPI retries in milliseconds                           | no                     | 500                           |
| KEYSAPI_API_RESPONSE_TIMEOUT_MS         | KeysAPI response timeout in milliseconds                                | no                     | 60_000                        |
| KEYSAPI_API_MAX_RETRIES                 | Maximum number of KeysAPI retries                                       | no                     | 3                             |
| START_ROOT                              | Start CL block root for the daemon (defaults to current finalized root) | no                     |                               |
| DAEMON_NODE_OPERATOR_IDS                | Comma-separated node operator IDs to prove (daemon mode only)           | no                     |                               |
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
| TX_GAS_LIMIT                            | Hard cap on transaction gas limit                                       | no                     | 2_000_000                     |
| TX_GAS_LIMIT_BUFFER_PERCENT             | Safety buffer added on top of `estimateGas` result (percent)            | no                     | 20                            |
| TX_HIGH_GAS_FEE_MAX_RETRIES             | Max retries when gas fee is too high before giving up                   | no                     | 13                            |
| TX_HIGH_GAS_FEE_RETRY_DELAY_MS          | Delay between high-gas-fee retries in milliseconds                      | no                     | 60_000                        |
| TX_MINING_WAITING_TIMEOUT_MS            | Timeout for waiting for transaction mining confirmation                 | no                     | 180_000 (3 min)               |
| TX_CONFIRMATIONS                        | Number of block confirmations required after mining                     | no                     | 1                             |
| TX_STRIKES_PAYLOAD_MAX_BATCH_SIZE       | Max number of strikes packed into a single transaction                  | no                     | 10                            |
| BALANCE_PROOF_MIN_DELTA_GWEI            | Minimum balance increase above confirmed level to trigger a proof       | no                     | 512_000_000_000 (512 ETH)     |
| KEYS_INDEXER_RUNNING_PERIOD_MS          | How often the keys indexer re-syncs with KeysAPI                        | no                     | 10_800_000 (3 hours)          |
| KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD_MS | Max age of KeysAPI data considered fresh enough to trust                | no                     | 28_800_000 (8 hours)          |
| HTTP_PORT                               | Port for the metrics/health HTTP server                                 | no                     | 8080                          |
| LOG_LEVEL                               | Log level (`error`, `warn`, `info`, `debug`)                            | no                     | info                          |
| LOG_FORMAT                              | Log format (`simple` or `json`)                                         | no                     | simple                        |



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
