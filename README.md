<p align="center">
  <img src="logo.png" width="120" alt="CSM Logo"/>
</p>
<h1 align="center"> CSM Prover Tool </h1>

## Description

Tool for reporting Slashings and Withdrawals for Lido Community Staking Module

### Daemon working mode

The tool is a daemon that listens to the CL and reports any slashings and withdrawals to the Lido Community Staking Module.

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
   > - If the current state of keys indexer is healthy enough to be trusted completely, remove the root from roots stack
4. Build and send proofs to the CS Module contract if slashing or withdrawal was found.

So, according to the algorithm, there are the following statements:
1. We always go sequentially by the finalized roots of blocks, taking the next one by the root of the previous one. In this way, we avoid missing any blocks.
2. If for some reason the daemon crashes, it will start from the last root running before the crash when it is launched
3. If for some reason KeysAPI crashed or CL node stopped giving validators, we can use the previously successfully received data to guarantee that our slashings will report for another ~15h and withdrawals for ~27h (because of the new validators appearing time and `MIN_VALIDATOR_WITHDRAWABILITY_DELAY`)
   If any of these time thresholds are breached, we can't be sure that if there was a slashing or a full withdrawal there was definitely not our validator there. That's why we put the root block in the stack just in case, to process it again later when KeysAPI and CL node are well.

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
   $ yarn install
   $ yarn run typechain
   $ yarn build
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
   # Report slashing
   $ docker compose run -it --rm slashing
   # Report withdrawal
   $ docker compose run -it --rm withdrawal
   ```

   b. Or using yarn

   ```bash
   $ yarn install
   $ yarn run typechain
   $ yarn build
   # Report slashing
   $ yarn slashing
   # Report withdrawal
   $ yarn withdrawal
   ```

#### Options to run CLI

`--node-operator-id ` - Node operator ID

`--key-index` - Key index in the CSM module according to Node Operator

`--validator-index` - Validator index in the Consensus Layer

`--block` - Block number (slot or root of block on the Consensus Layer which contains the validator withdrawal or evidence of slashing)

`--help` - Show help

## Environment variables

| Name                                    | Description                                       | Required               | Default                  |
|-----------------------------------------|---------------------------------------------------|------------------------|--------------------------|
| WORKING_MODE                            | Working mode of the tool (daemon or cli)          | no                     | daemon                   |
| DRY_RUN                                 | Dry run mode                                      | no                     | false                    |
| EL_PRC_URLS                             | Comma-separated list of EL RPC URLs               | yes                    |                          |
| EL_RPC_RETRY_DELAY_MS                   | Delay between EL RPC retries in milliseconds      | no                     | 500                      |
| EL_RPC_RESPONSE_TIMEOUT_MS              | EL RPC response timeout in milliseconds           | no                     | 60_000                   |
| EL_RPC_MAX_RETRIES                      | Maximum number of EL RPC retries                  | no                     | 3                        |
| CL_API_URLS                             | Comma-separated list of CL API URLs               | yes                    |                          |
| CL_API_RETRY_DELAY_MS                   | Delay between CL API retries in milliseconds      | no                     | 500                      |
| CL_API_RESPONSE_TIMEOUT_MS              | CL API response timeout in milliseconds           | no                     | 60_000                   |
| CL_API_MAX_RETRIES                      | Maximum number of CL API retries                  | no                     | 3                        |
| KEYSAPI_API_URLS                        | Comma-separated list of KeysAPI API URLs          | yes (daemon mode only) |                          |
| KEYSAPI_API_RETRY_DELAY_MS              | Delay between KeysAPI API retries in milliseconds | no                     | 500                      |
| KEYSAPI_API_RESPONSE_TIMEOUT_MS         | KeysAPI API response timeout in milliseconds      | no                     | 60_000                   |
| KEYSAPI_API_MAX_RETRIES                 | Maximum number of KeysAPI API retries             | no                     | 3                        |
| START_ROOT                              | Start consensus layer block root for the daemon   | no                     |                          |
| CSM_ADDRESS                             | Address of the CSM contract                       | yes                    |                          |
| VERIFIER_ADDRESS                        | Address of the verifier contract                  | yes                    |                          |
| TX_SIGNER_PRIVATE_KEY                   | Private key of the transaction signer             | yes (if not dry run)   |                          |
| TX_MIN_GAS_PRIORITY_FEES                | Minimum gas priority fees for the transaction     | no                     | 50_000_000 (0.05 gwei)   |
| TX_MAX_GAS_PRIORITY_FEES                | Maximum gas priority fees for the transaction     | no                     | 10_000_000_000 (10 gwei) |
| TX_GAS_PRIORITY_FEE_PERCENTILE          | Gas priority fee percentile for the transaction   | no                     | 25                       |
| TX_GAS_FEE_HISTORY_DAYS                 | Days of gas fee history for analyzing gas         | no                     | 1                        |
| TX_GAS_FEE_HISTORY_PERCENTILE           | Gas fee percentile for analyzing gas              | no                     | 20                       |
| TX_GAS_LIMIT                            | Gas limit for the transaction                     | no                     | 1_000_000                |
| KEYS_INDEXER_RUNNING_PERIOD_MS          | Period of running keys indexer in milliseconds    | no                     | 3 * 3_600_000 (3 hours)  |
| KEYS_INDEXER_KEYAPI_FRESHNESS_PERIOD_MS | Period of keys indexer freshness in milliseconds  | no                     | 8 * 3_600_000 (8 hours)  |
| HTTP_PORT                               | Port for the HTTP server                          | no                     | 8080                     |
| LOG_LEVEL                               | Log level                                         | no                     | info                     |
| LOG_FORMAT                              | Log format                                        | no                     | simple                   |



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
