import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store';
import type { FeedbackContext } from '@/lib/feedbackContext';
import { messageError } from '@/lib/feedbackClient';
import { feedbackTransport } from '@/lib/feedbackTransport';
import { Modal } from './Modal';
import { Button } from './Button';
import { Field } from './Field';
import '@/styles/feedback.css';

export function FeedbackButton({ context, gate = false }: { context: FeedbackContext; gate?: boolean }) {
  return <button type="button" className={gate ? 'feedback-gate' : 'status-segment clickable feedback-trigger'}
    onClick={() => {
      const state = useAppStore.getState();
      if (state.settingsOpen || state.tipsOpen || state.paletteOpen || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      state.openFeedback(context);
    }}>Feedback</button>;
}

const errors = {
  validation: 'The service could not accept this message. Check your message before you try again.',
  blocked: 'The feedback service blocked this submission. Your draft is kept. Try again after the service is available.',
  limited: 'The feedback service has reached its limit. Your draft is kept. Try again later.',
  unavailable: 'The feedback service is unavailable. Your draft is kept. Try again later.',
  uncertain: 'Delivery was not confirmed. Your draft is kept. A retry can send a duplicate.',
} as const;

export function FeedbackDialog({ context }: { context: FeedbackContext }) {
  const open = useAppStore(s => s.feedbackOpen);
  const message = useAppStore(s => s.feedbackMessage);
  const draftContext = useAppStore(s => s.feedbackContext);
  const phase = useAppStore(s => s.feedbackPhase);
  const result = useAppStore(s => s.feedbackResult);
  const close = useAppStore(s => s.closeFeedback);
  const edit = useAppStore(s => s.editFeedback);
  const clear = useAppStore(s => s.clearFeedback);
  const send = useAppStore(s => s.sendFeedback);
  const input = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(Date.now);
  const retryAt = useAppStore(s => s.feedbackRetryAt);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); close(); return;
      }
      if ((event.metaKey || event.ctrlKey) && ["s", "k", ","].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
  useEffect(() => {
    if (!open || !retryAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, retryAt]);
  const wait = Math.max(0, Math.ceil(((retryAt ?? 0) - now) / 1000));
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('.feedback-dialog');
      if (dialog && !dialog.contains(document.activeElement)) {
        // eslint-disable-next-line no-restricted-syntax -- runs inside a `useEffect`'s rAF (already after commit); `.feedback-dialog` is already mounted, the rAF only lets a phase change settle before deciding whether focus already sits inside it.
        dialog.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, phase]);
  const busy = phase === 'sending';
  const error = messageError(message);
  const details = draftContext ?? context;
  return <Modal open={open} onClose={close} title="Feedback" initialFocus={input} className="feedback-dialog" footer={<>
    <Button onClick={close}>Close</Button>
    {message && <Button onClick={() => { clear(context); input.current?.focus(); }} disabled={busy}>Clear</Button>}
    <Button variant="primary" disabled={busy || !!error || wait > 0} onClick={() => void send(feedbackTransport)}>
      {busy ? 'Sending…' : wait > 0 ? `Wait ${wait}s` : phase === 'failed' ? 'Retry' : 'Send'}
    </Button>
  </>}>
    <p className="feedback-intro">What could work better?</p>
    <Field label="Message" htmlFor="feedback-message" error={message.length > 0 ? error : undefined}
      hint={message ? `${Array.from(message).length.toLocaleString()} / 4,000 characters` : "Enter a message before you send. Up to 4,000 characters."}>
      <textarea id="feedback-message" ref={input} value={message} disabled={busy} rows={6}
        placeholder="Tell us what happened or what you would change." onChange={e => { if (phase === "accepted") clear(context); edit(e.target.value); }} />
    </Field>
    <p className="feedback-privacy">No personal data attached automatically.</p>
    <details className="feedback-context"><summary tabIndex={0}>Included context</summary>
      <dl><dt>Screen</dt><dd>{details.screen}</dd><dt>Tab</dt><dd>{details.tab}</dd>
        <dt>App version</dt><dd>{details.appVersion}</dd><dt>Operating system</dt><dd>{details.os}</dd></dl>
    </details>
    <p className="feedback-provider">Your message goes through Formspree. It processes network metadata. Include only what you want to share. No reply is possible.</p>
    {phase === 'accepted' && <p role="status">Feedback sent. Thank you.</p>}
    {phase === 'failed' && result && result.kind !== 'accepted' && <p className="feedback-error" role="alert">{errors[result.kind]}</p>}
    {busy && <p role="status">Sending your feedback. You can close this dialog.</p>}
  </Modal>;
}
