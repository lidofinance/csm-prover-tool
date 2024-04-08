// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt#use_within_json
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export const bigIntMax = (...args: bigint[]) => args.reduce((m, e) => (e > m ? e : m));
export const bigIntMin = (...args: bigint[]) => args.reduce((m, e) => (e < m ? e : m));
export const percentile = (arr: bigint[], p: number) => {
  arr.sort((a, b) => Number(a - b));
  const index = (p / 100) * (arr.length - 1);
  if (Number.isInteger(index)) {
    return arr[index];
  } else {
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return (arr[lower] + arr[upper]) / 2n;
  }
};
