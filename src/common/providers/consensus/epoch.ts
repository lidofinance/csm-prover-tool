export const FAR_FUTURE_EPOCH = (1n << 64n) - 1n;

export function epochToBigInt(epoch: number): bigint {
  return epoch === Infinity ? FAR_FUTURE_EPOCH : BigInt(epoch);
}
