import { BaseError, ContractFunctionRevertedError, RawContractError } from 'viem';

// viem words a node error on the aggregate itself as a revert too, so only a subcall's RawContractError counts
export function findContractRevert(e: unknown): ContractFunctionRevertedError | undefined {
  if (!(e instanceof BaseError) || !e.walk((err) => err instanceof RawContractError)) return undefined;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert : undefined;
}
