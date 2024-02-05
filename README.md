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
1. Run `KeysIndexer` service to get the current validator set of the CS Module.
   > It is necessary at the first startup. All subsequent runs of the indexer will be performed when necessary and independently of the main processing*
2. Choose the next block service to process from `RootsProvider`.
   > The provider chooses the next root with the following priority:
   > - Return the root from `RootsStack` service if exists and `KeyIndexer` is helthy enougth to be trusted completely to process this root
   > - *When no any processed roots yet* Return a configured root (from `.env` file) or the last finalized root
   > - Return a finalized child root of the last processed root
   > - Sleep 12s if nothing to process and **return to the step 0**
3. Run `RootsProcessor` service to process the root.
   > The processor does the following:
   > - Get the block info from CL by the root
   > - If the current state of `KeysIndexer` is outdated (~15-27h behind from the block) to be trusted completely, add the block root to `RootsStack`
   > - If the block has a slashing or withdrawal, report it to the CS Module
   > - If the current state of `KeysIndexer` is helthy enougth to be trusted completely, remove the root from `RootsStack`

## Installation

```bash
$ yarn install
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
