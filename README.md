<p align="center">
  <img src="logo.png" width="120" alt="CSM Logo"/>
</p>
<h1 align="center"> CSM Prover Tool </h1>

## Description

Tool for reporting Slashings and Withdrawals for Lido Community Staking Module

### Daemon working mode

The tool is a daemon that listens to the CL and reports any slashings and withdrawals to the Lido Community Staking Module.

The algorithm is as follows:
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

So, according to the algorithm, there are the following statements:
1. We always go sequentially by the finalized roots of blocks, taking the next one by the root of the previous one. In this way, we avoid missing any blocks.
2. If for some reason the daemon crashes, it will start from the last root running before the crash when it is launched
3. If for some reason KeysAPI crashed or CL node stopped giving validators, we can use the previously successfully received data to guarantee that our slashings will report for another ~15h and withdrawals for ~27h (because of the new validators appearing time and `MIN_VALIDATOR_WITHDRAWABILITY_DELAY`)
If any of these time thresholds are breached, we can't be sure that if there was a slashing or a full withdrawal there was definitely not our validator there. That's why we put the root block in the stack just in case, to process it again later when KeysAPI and CL node are well.

## Installation

```bash
$ yarn install
$ yarn run typechain
```

## Running the app

```bash
# development
$ yarn run start

# watch mode
$ yarn run start:dev

# production mode
$ yarn run start:prod
```

## Test

```bash
# unit tests
$ yarn run test

# e2e tests
$ yarn run test:e2e

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
