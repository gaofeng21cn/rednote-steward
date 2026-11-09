import { AuthRequiredError, CliError, CommandExecutionError } from '@jackwener/opencli/errors';

/** Classify the observed route only; redirect query values are not page state. */
export function assertCreatorLocation(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new CommandExecutionError('The browser did not expose a valid creator URL'); }
  const trustedHost = url.hostname === 'creator.xiaohongshu.com' || url.hostname === 'passport.xiaohongshu.com';
  if (trustedHost && /(?:^|\/)(captcha|verify|verification|risk-control|security-check)(?:\/|$)/i.test(url.pathname)) {
    throw new CliError('VERIFICATION_REQUIRED', 'Xiaohongshu requires account verification in this Chrome profile',
      'Complete the visible platform verification, then inspect the current task before continuing.', 77);
  }
  if (url.hostname === 'passport.xiaohongshu.com' ||
      (url.origin === 'https://creator.xiaohongshu.com' && /(?:^|\/)(login|passport|website-login)(?:\/|$)/i.test(url.pathname))) {
    throw new AuthRequiredError('creator.xiaohongshu.com');
  }
  if (url.origin !== 'https://creator.xiaohongshu.com') {
    throw new CommandExecutionError('The browser left the Xiaohongshu creator origin');
  }
  return { origin: url.origin, pathname: url.pathname };
}
