import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ViewerAssertionClaims {
  exp: number;
  sub: string;
  subType: 'id' | 'email';
}

export function createViewerAssertion(claims: ViewerAssertionClaims, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = signViewerAssertionPayload(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function verifyViewerAssertion(
  assertion: string | null | undefined,
  secret: string | null | undefined,
  now = new Date(),
): ViewerAssertionClaims | null {
  if (!assertion || !secret) {
    return null;
  }

  const [encodedPayload, providedSignature, ...rest] = assertion.split('.');

  if (!encodedPayload || !providedSignature || rest.length > 0) {
    return null;
  }

  const expectedSignature = signViewerAssertionPayload(encodedPayload, secret);

  if (!signaturesMatch(providedSignature, expectedSignature)) {
    return null;
  }

  let parsedPayload: unknown;

  try {
    parsedPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const claimsRecord =
    parsedPayload && typeof parsedPayload === 'object'
      ? (parsedPayload as Record<string, unknown>)
      : null;

  if (
    !claimsRecord ||
    typeof claimsRecord.sub !== 'string' ||
    typeof claimsRecord.exp !== 'number' ||
    (claimsRecord.subType !== 'id' && claimsRecord.subType !== 'email')
  ) {
    return null;
  }

  const claims = claimsRecord as unknown as ViewerAssertionClaims;

  if (!Number.isInteger(claims.exp) || claims.exp <= Math.floor(now.getTime() / 1000)) {
    return null;
  }

  return claims;
}

function signViewerAssertionPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function signaturesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
