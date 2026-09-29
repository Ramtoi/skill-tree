import { create } from 'zustand';
import { it, expect, vi } from 'vitest';
import { createFeedbackSlice } from '@/store/feedback';
import type { FeedbackResult } from '@/lib/feedbackClient';
const context = { screen: 'project', tab: 'permissions', appVersion: '1.0.0', os: 'linux' } as const;
it('keeps a draft and context across closing and navigation; Clear starts here', () => {
  const store = create(createFeedbackSlice);
  store.getState().openFeedback(context); store.getState().editFeedback('My draft'); store.getState().closeFeedback();
  store.getState().openFeedback({ ...context, screen: 'library', tab: 'none' });
  expect(store.getState().feedbackContext).toEqual(context); expect(store.getState().feedbackMessage).toBe('My draft');
  store.getState().clearFeedback({ ...context, screen: 'library', tab: 'none' });
  expect(store.getState().feedbackContext?.screen).toBe('library'); expect(store.getState().feedbackMessage).toBe('');
});
it('prevents double send and edits across dismissal, then clears on acceptance', async () => {
  const store = create(createFeedbackSlice);
  let resolve!: (result: FeedbackResult) => void;
  const transport = vi.fn(() => new Promise<FeedbackResult>(r => { resolve = r; }));
  store.getState().openFeedback(context); store.getState().editFeedback('Draft');
  const request = store.getState().sendFeedback(transport);
  store.getState().closeFeedback(); store.getState().openFeedback(context);
  store.getState().editFeedback('Changed'); store.getState().clearFeedback(context);
  await store.getState().sendFeedback(transport);
  expect(transport).toHaveBeenCalledTimes(1); expect(store.getState().feedbackMessage).toBe('Draft');
  expect(store.getState().feedbackPhase).toBe('sending');
  resolve({ kind: 'accepted' }); await request;
  expect(store.getState().feedbackMessage).toBe(''); expect(store.getState().feedbackPhase).toBe('accepted');
});
it('keeps failed drafts and respects retry deadlines even after editing', async () => {
  const store = create(createFeedbackSlice);
  const transport = vi.fn().mockResolvedValue({ kind: 'limited', retryAt: Date.now() + 60000 });
  store.getState().openFeedback(context); store.getState().editFeedback('Draft');
  await store.getState().sendFeedback(transport); store.getState().editFeedback('Edited');
  await store.getState().sendFeedback(transport);
  expect(transport).toHaveBeenCalledTimes(1); expect(store.getState().feedbackMessage).toBe('Edited');
});
