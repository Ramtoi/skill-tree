import { createFeedbackTransport, type FeedbackTransport } from './feedbackClient';
// Vite replaces this module with the fake adapter in every preview build.
export const feedbackTransport: FeedbackTransport = createFeedbackTransport((...args) => fetch(...args));
