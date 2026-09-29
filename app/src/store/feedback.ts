import type { StateCreator } from 'zustand';
import { sanitizeFeedbackContext, type FeedbackContext, type FeedbackScreen, type FeedbackTab } from '@/lib/feedbackContext';
import { messageError, type FeedbackResult, type FeedbackTransport } from '@/lib/feedbackClient';

export interface FeedbackSlice {
  feedbackOpen: boolean;
  feedbackMessage: string;
  feedbackContext: FeedbackContext | null;
  feedbackPhase: 'draft' | 'sending' | 'accepted' | 'failed';
  feedbackResult: FeedbackResult | null;
  feedbackRequest: number;
  feedbackRetryAt: number;
  feedbackTabs: Partial<Record<FeedbackScreen, FeedbackTab>>;
  setFeedbackTab: (screen: FeedbackScreen, tab: FeedbackTab | undefined) => void;
  openFeedback: (context: FeedbackContext) => void;
  closeFeedback: () => void;
  editFeedback: (message: string) => void;
  clearFeedback: (context: FeedbackContext) => void;
  sendFeedback: (transport: FeedbackTransport) => Promise<void>;
}
// This slice has no persistence. A close never cancels or duplicates a request.
export const createFeedbackSlice: StateCreator<FeedbackSlice, [], [], FeedbackSlice> = (set, get) => ({
  feedbackOpen: false, feedbackMessage: '', feedbackContext: null, feedbackPhase: 'draft',
  feedbackResult: null, feedbackRequest: 0, feedbackRetryAt: 0, feedbackTabs: {},
  setFeedbackTab: (screen, tab) => set(s => ({ feedbackTabs: { ...s.feedbackTabs, [screen]: tab } })),
  openFeedback: context => set(s => ({ feedbackOpen: true,
    ...(!s.feedbackMessage && s.feedbackPhase !== 'sending' ? { feedbackContext: sanitizeFeedbackContext(context), feedbackPhase: 'draft' as const, feedbackResult: null } : {}) })),
  closeFeedback: () => set({ feedbackOpen: false }),
  editFeedback: message => { if (get().feedbackPhase !== 'sending') set({ feedbackMessage: message, feedbackPhase: 'draft', feedbackResult: null }); },
  clearFeedback: context => { if (get().feedbackPhase !== 'sending') set({ feedbackMessage: '', feedbackContext: sanitizeFeedbackContext(context), feedbackPhase: 'draft', feedbackResult: null }); },
  sendFeedback: async transport => {
    const s = get();
    if (s.feedbackPhase === 'sending' || !s.feedbackContext || messageError(s.feedbackMessage)) return;
    if (s.feedbackRetryAt > Date.now()) return;
    const request = s.feedbackRequest + 1;
    set({ feedbackPhase: 'sending', feedbackResult: null, feedbackRequest: request });
    let result: FeedbackResult;
    try { result = await transport({ message: s.feedbackMessage, ...sanitizeFeedbackContext(s.feedbackContext) }); }
    catch { result = { kind: 'uncertain' }; }
    if (get().feedbackRequest !== request) return;
    set({ feedbackRetryAt: result.kind === 'limited' ? result.retryAt ?? 0 : 0, feedbackPhase: result.kind === 'accepted' ? 'accepted' : 'failed', feedbackResult: result,
      ...(result.kind === 'accepted' && get().feedbackMessage === s.feedbackMessage ? { feedbackMessage: '' } : {}) });
  },
});
