export const FEEDBACK_SCREENS = ['library', 'skill', 'project', 'bundle', 'sources', 'permissions', 'harnesses', 'harness', 'harness-doc', 'snippets', 'snippet', 'hooks', 'hook', 'remotes', 'remote', 'cloud', 'usage', 'usage-project', 'usage-session', 'usage-pinned', 'backup', 'loading', 'setup', 'runtime-error', 'unknown'] as const;
export type FeedbackScreen = typeof FEEDBACK_SCREENS[number];
export const FEEDBACK_TABS = ['none', 'unknown', 'loadout', 'agent-docs', 'permissions', 'subagents', 'usage', 'edit', 'preview', 'diff', 'split', 'timeline', 'tools', 'changes'] as const;
export type FeedbackTab = typeof FEEDBACK_TABS[number];
export type FeedbackContext = { screen: FeedbackScreen; tab: FeedbackTab; appVersion: string; os: 'macos' | 'windows' | 'linux' | 'unknown' };
const routes: readonly [RegExp, FeedbackScreen][] = [
  [/^\/$/, 'library'], [/^\/skill\/[^/]+$/, 'skill'], [/^\/project\/[^/]+$/, 'project'],
  [/^\/bundle\/[^/]+$/, 'bundle'], [/^\/sources$/, 'sources'], [/^\/permissions$/, 'permissions'],
  [/^\/harnesses$/, 'harnesses'], [/^\/harness\/[^/]+\/doc$/, 'harness-doc'], [/^\/harness\/[^/]+$/, 'harness'],
  [/^\/snippets$/, 'snippets'], [/^\/snippet\/[^/]+$/, 'snippet'], [/^\/hooks$/, 'hooks'], [/^\/hook\/[^/]+$/, 'hook'],
  [/^\/remotes$/, 'remotes'], [/^\/remote\/[^/]+$/, 'remote'], [/^\/cloud\/[^/]+$/, 'cloud'],
  [/^\/usage$/, 'usage'], [/^\/usage\/project\/[^/]+$/, 'usage-project'], [/^\/usage\/session\/[^/]+$/, 'usage-session'],
  [/^\/usage\/pinned$/, 'usage-pinned'], [/^\/backup$/, 'backup'],
];
export function feedbackScreen(pathname: string): FeedbackScreen {
  return routes.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'unknown';
}
export function sanitizeFeedbackContext(input: { screen?: string; tab?: string; appVersion?: string; os?: string }): FeedbackContext {
  return {
    screen: FEEDBACK_SCREENS.includes(input.screen as FeedbackScreen) ? input.screen as FeedbackScreen : 'unknown',
    tab: FEEDBACK_TABS.includes(input.tab as FeedbackTab) ? input.tab as FeedbackTab : 'unknown',
    appVersion: /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,32})?$/.test(input.appVersion ?? '') ? input.appVersion! : 'unknown',
    os: ['macos', 'windows', 'linux'].includes(input.os ?? '') ? input.os as FeedbackContext['os'] : 'unknown',
  };
}
export function feedbackOS(platform: string): FeedbackContext['os'] {
  if (/mac/i.test(platform)) return 'macos';
  if (/win/i.test(platform)) return 'windows';
  if (/linux/i.test(platform)) return 'linux';
  return 'unknown';
}
