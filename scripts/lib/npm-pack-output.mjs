export function parsePackOutput(output, expectedName) {
  const value = typeof output === 'string' ? JSON.parse(output) : output;
  const rows = Array.isArray(value) ? value
    : value?.files ? [value] : value && typeof value === 'object' ? Object.values(value) : [];
  const matching = rows.filter(row => row?.name === expectedName && Array.isArray(row.files));
  if (matching.length !== 1 || !matching[0].files.every(file => file && typeof file.path === 'string')) {
    throw new Error(`Expected one npm pack record with a file list for ${expectedName}`);
  }
  return matching[0];
}
