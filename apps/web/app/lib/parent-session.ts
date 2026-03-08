const parentAccessTokenStorageKey = 'little.parentAccessToken';
const parentAccessCookieName = 'parent_access_token';
const defaultSessionTtlSec = 60 * 60 * 24 * 30;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const entries = document.cookie ? document.cookie.split(';') : [];
  for (const rawEntry of entries) {
    const [rawName, ...rawValue] = rawEntry.trim().split('=');
    if (rawName !== name || rawValue.length === 0) {
      continue;
    }

    const joinedValue = rawValue.join('=').trim();
    if (!joinedValue) {
      return null;
    }

    try {
      return decodeURIComponent(joinedValue);
    } catch {
      return joinedValue;
    }
  }

  return null;
}

export function readParentSessionTokenFromBrowser(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const localStorageToken = window.localStorage.getItem(parentAccessTokenStorageKey);
  if (localStorageToken && localStorageToken.trim().length > 0) {
    return localStorageToken.trim();
  }

  const cookieToken = readCookie(parentAccessCookieName);
  return cookieToken && cookieToken.trim().length > 0 ? cookieToken.trim() : null;
}

export function persistParentSessionToken(token: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = token.trim();
  if (!normalized) {
    return;
  }

  window.localStorage.setItem(parentAccessTokenStorageKey, normalized);

  const secureSuffix = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${parentAccessCookieName}=${encodeURIComponent(normalized)}; Path=/; Max-Age=${String(defaultSessionTtlSec)}; SameSite=Lax${secureSuffix}`;
}

export function clearParentSessionToken(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(parentAccessTokenStorageKey);
  document.cookie = `${parentAccessCookieName}=; Path=/; Max-Age=0; SameSite=Lax`;
}
