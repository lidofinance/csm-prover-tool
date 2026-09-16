// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt#use_within_json
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m));
export const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m));
export const percentile = (arr: bigint[], p: number) => {
  // NOTE: copy before sorting, the caller's array keeps its chronological order
  const sorted = [...arr].sort((a, b) => Number(a - b));
  const index = (p / 100) * (sorted.length - 1);
  if (Number.isInteger(index)) {
    return sorted[index];
  } else {
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return (sorted[lower] + sorted[upper]) / 2n;
  }
};
