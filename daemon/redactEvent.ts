/**
 * Redaction for events on their way into the daemon journal.
 *
 * `redactForStorage` fails closed by returning a marker STRING, which is the right thing for a log line
 * or a note but not for a journal entry: an entry must stay a well-formed wire event or the replay,
 * the checkpoint fold and every client's frame decoder would choke on it. So the journal gets this
 * wrapper, which substitutes a small, valid, secret-free event when redaction could not run.
 */
import { isWireEvent, type WireEvent } from '../src/protocol';
import { redactForStorage } from '../src/secretRedaction';

/** Shown in place of an event whose redaction failed. A known callback with a plain-text payload: clients render it, nothing else reads it. Built fresh per call so no caller can mutate a shared instance. */
function redactionFailedEvent(): WireEvent {
  return {
    name: 'onNotification',
    args: ['An event was withheld because it could not be checked for secrets (redaction failed).', 'low'],
  };
}

export function redactWireEvent(event: WireEvent): WireEvent {
  const out = redactForStorage(event);
  if (!isWireEvent(out)) return redactionFailedEvent();
  return out;
}
