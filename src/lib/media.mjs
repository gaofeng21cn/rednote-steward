// Ignore CDN host rotation and expiring queries when comparing media paths.
export function videoSourceIdentity(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.pathname : null;
  } catch { return null; }
}

export function videoSourceChanged(before, after) {
  const previous = videoSourceIdentity(before);
  const current = videoSourceIdentity(after);
  return Boolean(previous && current && previous !== current);
}
