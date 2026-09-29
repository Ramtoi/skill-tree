import { it, expect, vi, afterEach } from 'vitest';
import { createFeedbackTransport, messageError, FEEDBACK_ENDPOINT } from '@/lib/feedbackClient';
import { feedbackScreen, feedbackOS } from '@/lib/feedbackContext';
const payload = { message: 'This view is confusing.', screen: 'project', tab: 'permissions', appVersion: '1.0.0', os: 'linux' };
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
afterEach(() => vi.useRealTimers());
it('excludes private values and uses no credentials or referrer', async () => {
  const fetcher = vi.fn().mockResolvedValue(response({ next: "/thanks", ok: true }));
  expect(await createFeedbackTransport(fetcher)({ ...payload, screen: '/project/private-company', tab: 'secret.txt', os: 'private-host', appVersion: '/home/private', path: '/secret' } as typeof payload)).toEqual({ kind: 'accepted' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe(FEEDBACK_ENDPOINT);
  expect(options).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  expect(JSON.parse(options.body)).toEqual({ message: payload.message, screen: 'unknown', tab: 'unknown', appVersion: 'unknown', os: 'unknown' });
});
it('counts Unicode code points without truncation', async () => {
  expect(messageError('😀'.repeat(4000))).toBeNull();
  const fetcher = vi.fn();
  for (const message of ['   ', '😀'.repeat(4001)]) expect(await createFeedbackTransport(fetcher)({ ...payload, message })).toEqual({ kind: 'validation' });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([{}, { ok: false }, { next: '/thanks' }, { ok: 'true' }, null])('does not claim success for %j', async body => {
  expect(await createFeedbackTransport(vi.fn().mockResolvedValue(response(body)))(payload)).toEqual({ kind: 'uncertain' });
});
it('rejects HTML and malformed JSON', async () => {
  for (const r of [new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('{broken', { headers: { 'Content-Type': 'application/json' } })]) expect(await createFeedbackTransport(vi.fn().mockResolvedValue(r))(payload)).toEqual({ kind: r.headers.get('Content-Type') === 'text/html' ? 'blocked' : 'uncertain' });
});
it.each([[403, 'blocked'], [422, 'validation'], [500, 'unavailable'], [429, 'limited']] as const)('classifies HTTP %i', async (status, kind) => {
  expect(await createFeedbackTransport(vi.fn().mockResolvedValue(response({ error: 'private provider detail' }, status)))(payload)).toEqual({ kind });
});
it('honors the provider retry delay', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  expect(await createFeedbackTransport(vi.fn().mockResolvedValue(response({}, 429, { 'Retry-After': '30' })))(payload)).toEqual({ kind: 'limited', retryAt: 130000 });
});
it('times out once without retrying', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const pending = createFeedbackTransport(fetcher)(payload);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toEqual({ kind: 'uncertain' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('classifies displayed routes without identifiers', () => {
  expect(feedbackScreen('/project/private-company')).toBe('project');
  expect(feedbackScreen('/usage/session/private-session')).toBe('usage-session');
  expect(feedbackScreen('/harness/private/doc')).toBe('harness-doc');
  expect(feedbackScreen('/unknown/private')).toBe('unknown');
  expect(['MacIntel', 'Win32', 'Linux x86_64', 'private-host'].map(feedbackOS)).toEqual(['macos', 'windows', 'linux', 'unknown']);
});
it('rejects redirects and lost responses without displaying provider details', async () => {
  const redirected = response({ next: '/thanks', ok: true });
  Object.defineProperty(redirected, 'redirected', { value: true });
  expect(await createFeedbackTransport(vi.fn().mockResolvedValue(redirected))(payload)).toEqual({ kind: 'uncertain' });
  expect(await createFeedbackTransport(vi.fn().mockRejectedValue(new Error('private hostname')))(payload)).toEqual({ kind: 'uncertain' });
});
it.each([
  ['/', 'library'], ['/skill/private', 'skill'], ['/project/private', 'project'], ['/bundle/private', 'bundle'],
  ['/sources', 'sources'], ['/permissions', 'permissions'], ['/harnesses', 'harnesses'], ['/harness/private', 'harness'],
  ['/harness/private/doc', 'harness-doc'], ['/snippets', 'snippets'], ['/snippet/private', 'snippet'], ['/hooks', 'hooks'],
  ['/hook/private', 'hook'], ['/remotes', 'remotes'], ['/remote/private', 'remote'], ['/cloud/private', 'cloud'],
  ['/usage', 'usage'], ['/usage/project/private', 'usage-project'], ['/usage/session/private', 'usage-session'],
  ['/usage/pinned', 'usage-pinned'], ['/backup', 'backup'], ['/private', 'unknown'],
])('classifies %s as %s', (route, expected) => expect(feedbackScreen(route)).toBe(expected));

it('treats an empty success response as unconfirmed delivery', async () => {
  expect(await createFeedbackTransport(vi.fn().mockResolvedValue(new Response(null, { status: 204 })))(payload)).toEqual({ kind: 'uncertain' });
});
