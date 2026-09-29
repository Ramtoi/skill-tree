import { useEffect } from 'react';
import { useAppStore } from '@/store';
import type { FeedbackScreen, FeedbackTab } from '@/lib/feedbackContext';
/** Register only fixed local view names, never resource names or paths. */
export function useFeedbackTab(screen: FeedbackScreen, tab: FeedbackTab) {
  useEffect(() => {
    useAppStore.getState().setFeedbackTab(screen, tab);
    return () => useAppStore.getState().setFeedbackTab(screen, undefined);
  }, [screen, tab]);
}
