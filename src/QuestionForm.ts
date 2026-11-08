/**
 * Shared renderer for the body of a question card: header, question text, one
 * radio/checkbox row per option and an optional free-text "Other" row. Used by
 * ThreadsView (desktop card), MobileView (mobile card) and KanbanView (inline
 * answering of pending questions and orchestrator decisions). Chrome (card
 * frame, title, Submit button) stays with the caller; this returns a
 * `collect()` that reads the final selection straight from the DOM.
 *
 * Secret questions render a masked input and nothing here ever echoes an
 * answer back into the DOM.
 */
import type { AskQuestion } from './types';

export interface QuestionFormClasses {
  question: string;
  header: string;
  text: string;
  options: string;
  option: string;
  optionLabel: string;
  optName: string;
  optDesc: string;
  optionOther: string;
  otherText: string;
}

export const DESKTOP_QUESTION_CLASSES: QuestionFormClasses = {
  question: 'ct-question',
  header: 'ct-question-header',
  text: 'ct-question-text',
  options: 'ct-question-options',
  option: 'ct-question-option',
  optionLabel: 'ct-question-option-label',
  optName: 'ct-question-opt-name',
  optDesc: 'ct-question-opt-desc',
  optionOther: 'ct-question-option-other',
  otherText: 'ct-question-other-text',
};

export const MOBILE_QUESTION_CLASSES: QuestionFormClasses = {
  question: 'ct-mobile-question',
  header: 'ct-mobile-question-title',
  text: 'ct-mobile-question-text',
  options: 'ct-mobile-question-options',
  option: 'ct-mobile-question-option',
  optionLabel: 'ct-mobile-question-option-label',
  optName: 'ct-mobile-question-opt-name',
  optDesc: 'ct-mobile-question-opt-desc',
  optionOther: 'ct-mobile-question-option-other',
  otherText: 'ct-mobile-question-other-text',
};

let formCounter = 0;

/** Clicking anywhere on a row toggles its input (radio: select; checkbox: flip). */
function bindRowClick(row: HTMLElement, inputEl: HTMLInputElement): void {
  row.addEventListener('click', (e) => {
    if (e.target === inputEl) return;
    if (inputEl.type === 'checkbox') inputEl.checked = !inputEl.checked;
    else inputEl.checked = true;
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * In-memory draft of a question form's inputs, owned by the caller so it
 * outlives the DOM (the Kanban board rebuilds cards wholesale when any thread
 * changes). Never persisted. Free text of secret questions is deliberately
 * not captured, so a secret is never held or re-rendered outside the live input.
 */
export interface QuestionDraft {
  fields: Record<string, { checked: string[]; other: string }>;
}

interface FieldRefs {
  question: AskQuestion;
  optionInputs: HTMLInputElement[];
  otherInput?: HTMLInputElement;
  otherText?: HTMLInputElement;
}

/**
 * Renders every question into `body` and returns a `collect()` producing the
 * answers map keyed by `question.id ?? question.question` (multi-select values
 * joined with a comma, matching the existing card).
 */
export function renderQuestionFields(
  body: HTMLElement,
  questions: AskQuestion[],
  classes: QuestionFormClasses = DESKTOP_QUESTION_CLASSES,
  draft?: QuestionDraft,
): () => Record<string, string> {
  // Radio groups are document-scoped by name, so two forms on one page (the
  // Kanban board) must not share a group just because their question text matches.
  const formId = ++formCounter;
  const refs: FieldRefs[] = [];

  questions.forEach((q, qi) => {
    const qEl = body.createDiv({ cls: classes.question });
    if (q.header) qEl.createEl('h3', { cls: classes.header, text: q.header });
    qEl.createEl('p', { cls: classes.text, text: q.question });

    const groupName = `qf${formId}-${qi}`;
    const optionsEl = qEl.createDiv({ cls: classes.options });
    const optionInputs: HTMLInputElement[] = [];
    for (const opt of q.options) {
      const row = optionsEl.createDiv({ cls: classes.option });
      const inputEl = row.createEl('input', {
        attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: groupName, value: opt.label },
      }) as HTMLInputElement;
      const labelEl = row.createEl('label', { cls: classes.optionLabel });
      labelEl.createSpan({ cls: classes.optName, text: opt.label });
      if (opt.description) labelEl.createSpan({ cls: classes.optDesc, text: opt.description });
      bindRowClick(row, inputEl);
      optionInputs.push(inputEl);
    }

    let otherInput: HTMLInputElement | undefined;
    let otherText: HTMLInputElement | undefined;
    if (q.allowOther !== false) {
      const otherRow = optionsEl.createDiv({ cls: `${classes.option} ${classes.optionOther}` });
      otherInput = otherRow.createEl('input', {
        attr: { type: q.multiSelect ? 'checkbox' : 'radio', name: groupName, value: '__other__' },
      }) as HTMLInputElement;
      bindRowClick(otherRow, otherInput);
      const otherLabelEl = otherRow.createEl('label', { cls: classes.optionLabel });
      otherLabelEl.createSpan({ cls: classes.optName, text: q.options.length > 0 ? 'Other' : 'Answer' });
      otherText = otherLabelEl.createEl('input', {
        cls: classes.otherText,
        attr: {
          type: q.isSecret ? 'password' : 'text',
          placeholder: q.isSecret ? 'Enter secret…' : 'Type your own answer…',
          autocomplete: q.isSecret ? 'off' : 'on',
        },
      }) as HTMLInputElement;
      const other = otherInput;
      otherText.addEventListener('input', () => {
        if (!other.checked) other.checked = true;
      });
      otherText.addEventListener('click', (e) => e.stopPropagation());
      otherText.dataset.fieldKey = String(qi);
    }

    refs.push({ question: q, optionInputs, otherInput, otherText });
  });

  if (draft) {
    const save = (): void => {
      refs.forEach(({ question, optionInputs, otherInput, otherText }, i) => {
        const checked = optionInputs.filter((el) => el.checked).map((el) => el.value);
        if (otherInput?.checked) checked.push('__other__');
        draft.fields[String(i)] = { checked, other: question.isSecret ? '' : (otherText?.value ?? '') };
      });
    };
    refs.forEach(({ optionInputs, otherInput, otherText }, i) => {
      const saved = draft.fields[String(i)];
      if (!saved) return;
      for (const el of optionInputs) el.checked = saved.checked.includes(el.value);
      if (otherInput) otherInput.checked = saved.checked.includes('__other__');
      if (otherText && saved.other) otherText.value = saved.other;
    });
    body.addEventListener('change', save);
    body.addEventListener('input', save);
  }

  return () => {
    const result: Record<string, string> = {};
    for (const { question, optionInputs, otherInput, otherText } of refs) {
      const values: string[] = [];
      for (const input of optionInputs) if (input.checked) values.push(input.value);
      if (otherInput?.checked) {
        const text = otherText?.value.trim();
        if (text) values.push(text);
      }
      result[question.id ?? question.question] = values.join(',');
    }
    return result;
  };
}
