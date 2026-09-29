import type { FeedbackTransport } from '../lib/feedbackClient';
import { sceneValue } from './scenes';
/** Never calls fetch. Preview flags are local simulations only. */
export const feedbackTransport: FeedbackTransport = async () => {
  const state = sceneValue('feedback');
  await new Promise(resolve => setTimeout(resolve, state === 'sending' ? 60000 : 350));
  if (state === 'blocked') return { kind: 'blocked' };
  if (state === 'uncertain') return { kind: 'uncertain' };
  if (state === 'limited') return { kind: 'limited', retryAt: Date.now() + 3000 };
  return { kind: 'accepted' };
};
