'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { useEffect, useState } from 'react';

import { persistParentSessionToken, readParentSessionTokenFromBrowser } from '../../lib/parent-session';

interface AuthRecoveryCardProps {
  orderId: string;
  recoveryHref: string;
}

const sessionAttemptPrefix = 'little.orderAuthRestoreAttempt';

export function AuthRecoveryCard({ orderId, recoveryHref }: AuthRecoveryCardProps): JSX.Element {
  const [browserTokenDetected, setBrowserTokenDetected] = useState(false);
  const [attemptedBrowserRestore, setAttemptedBrowserRestore] = useState(false);
  const [helperMessage, setHelperMessage] = useState('');

  useEffect(() => {
    const token = readParentSessionTokenFromBrowser();
    if (!token) {
      return;
    }

    setBrowserTokenDetected(true);
    const attemptKey = `${sessionAttemptPrefix}:${orderId}`;
    if (window.sessionStorage.getItem(attemptKey) === '1') {
      return;
    }

    window.sessionStorage.setItem(attemptKey, '1');
    setAttemptedBrowserRestore(true);
    setHelperMessage('Attempting to restore your parent session from this browser...');
    persistParentSessionToken(token);
    window.location.reload();
  }, [orderId]);

  function retryBrowserSessionRestore(): void {
    const token = readParentSessionTokenFromBrowser();
    if (!token) {
      setHelperMessage('No saved parent session token was found in this browser.');
      return;
    }

    setAttemptedBrowserRestore(true);
    setHelperMessage('Retrying browser session restore...');
    persistParentSessionToken(token);
    window.location.reload();
  }

  return (
    <>
      <p>Your parent session is missing or expired. Restore it with the original parent email, then return to this order.</p>
      {attemptedBrowserRestore ? <p>{helperMessage || 'A browser-session restore attempt is in progress...'}</p> : null}
      {browserTokenDetected ? (
        <button type="button" onClick={retryBrowserSessionRestore}>
          Retry with browser session
        </button>
      ) : null}
      <Link href={recoveryHref as Route}>Restore parent session</Link>
      <p>If this order came from a gift email, reopening that redemption link will also restore access.</p>
    </>
  );
}
