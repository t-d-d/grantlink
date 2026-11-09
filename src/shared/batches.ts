// Splits a list into batches of at most `size`, in order.
export function batches<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`batch size must be a whole number above 0: ${size}`);
  }
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );
}
