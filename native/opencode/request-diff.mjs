// Exact structural comparison for captured JSON; no field ignore list.
export function diffRequestJSON(reference, native, path = '') {
  if (reference === native) return [];
  if (reference === null || native === null || typeof reference !== 'object' || typeof native !== 'object' || Array.isArray(reference) !== Array.isArray(native)) {
    return [{ path, reference, native }];
  }
  const differences = [];
  if (Array.isArray(reference) && reference.length !== native.length) differences.push({ path: path + '/length', reference: reference.length, native: native.length });
  for (const key of new Set([...Object.keys(reference), ...Object.keys(native)])) {
    const at = path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
    if (Object.hasOwn(reference, key) !== Object.hasOwn(native, key)) differences.push({ path: at, reference: reference[key], native: native[key] });
    else differences.push(...diffRequestJSON(reference[key], native[key], at));
  }
  return differences;
}
