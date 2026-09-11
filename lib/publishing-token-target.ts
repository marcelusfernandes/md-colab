export function planIdFromTarget(value: string, origin: string) {
  const target = value.trim();
  if (/^[0-9a-f-]{36}$/i.test(target)) return target;
  try {
    const url = new URL(target);
    const parts = url.pathname.split('/').filter(Boolean);
    return url.origin === origin &&
      parts.length === 2 &&
      parts[0] === 'd' &&
      /^[0-9a-f-]{36}$/i.test(parts[1])
      ? parts[1]
      : null;
  } catch {
    return null;
  }
}
