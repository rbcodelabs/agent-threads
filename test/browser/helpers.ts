/**
 * Layout/scroll settling helpers shared with `test/screenshots/helpers.ts`.
 * `shot()` is intentionally NOT re-exported here: pixel-baseline assertions
 * belong exclusively in `test/screenshots/`.
 */
export {
  settleView,
  anchorFocusedComposerToBottom,
  pinMessagesToBottom,
} from '../screenshots/helpers';
