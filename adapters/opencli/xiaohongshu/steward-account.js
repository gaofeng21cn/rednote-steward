import { cli, Strategy } from '@jackwener/opencli/registry';
import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

// Read the creator session itself: a public-site login may belong to a different account.
export function creatorIdentityScript() {
  return `async () => {
    const response = await fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' });
    const result = await response.json();
    if (!response.ok || !result?.data) return { logged_in: false, status: response.status };
    const data = result.data;
    const candidate = data.user_id || data.userId || data.userid || data.id || '';
    let userId = /^[a-f0-9]{24}$/i.test(String(candidate)) ? String(candidate) : '';
    const username = String(data.name || data.nickname || '');
    let identitySource = userId ? 'creator-personal-info' : 'unresolved';
    if (!userId && data.red_num) {
      // The current creator UI stores the stable ID beside its public account
      // number. Tie that representation to this fresh authenticated response;
      // stale browser state alone is never sufficient identity evidence.
      let creator = null;
      try { creator = JSON.parse(localStorage.getItem('USER_INFO_FOR_BIZ') || 'null'); } catch {}
      if (creator && String(creator.redId) === String(data.red_num) &&
          String(creator.userName) === username && /^[a-f0-9]{24}$/i.test(String(creator.userId))) {
        userId = String(creator.userId);
        identitySource = 'creator-profile-linked-state';
      }
    }
    return { logged_in: true, userId, username, identitySource };
  }`;
}

export async function readCreatorIdentity(page) {
  await page.goto('https://creator.xiaohongshu.com/new/home');
  const row = await page.evaluate(creatorIdentityScript());
  if (!row?.logged_in) throw new AuthRequiredError('creator.xiaohongshu.com');
  if (!row.userId) {
    throw new CommandExecutionError('Creator login is present, but its stable user ID is unavailable. Account binding needs a stable ID from the creator session.');
  }
  return row;
}

cli({
  site: 'xiaohongshu', name: 'steward-account',
  description: 'Read the creator session account name and stable user ID',
  access: 'read', domain: 'creator.xiaohongshu.com', strategy: Strategy.COOKIE,
  browser: true, navigateBefore: false, args: [],
  columns: ['logged_in', 'userId', 'username', 'identitySource'],
  func: async page => [await readCreatorIdentity(page)],
});
