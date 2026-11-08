/**
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom';
import { describe, expect, it } from 'vitest';
import { MOBILE_QUESTION_CLASSES, renderQuestionFields, type QuestionDraft } from '../../src/QuestionForm';
import type { AskQuestion } from '../../src/types';

const single: AskQuestion = { question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'first' }, { label: 'B', description: '' }], multiSelect: false };

describe('renderQuestionFields', () => {
  it('collects a radio selection keyed by question text', () => {
    const body = document.createElement('div');
    const collect = renderQuestionFields(body, [single]);
    body.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].checked = true;
    expect(collect()).toEqual({ 'Which?': 'B' });
  });

  it('joins multi-select values and appends the Other text; keys by id when present', () => {
    const body = document.createElement('div');
    const collect = renderQuestionFields(body, [{ ...single, id: 'q1', multiSelect: true }]);
    const boxes = body.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    boxes[0].checked = true;
    const text = body.querySelector<HTMLInputElement>('input.ct-question-other-text')!;
    text.value = ' custom ';
    text.dispatchEvent(new Event('input'));
    expect(collect()).toEqual({ q1: 'A,custom' });
  });

  it('omits Other when allowOther is false and masks secret input', () => {
    const body = document.createElement('div');
    renderQuestionFields(body, [{ ...single, allowOther: false }]);
    expect(body.querySelector('.ct-question-other-text')).toBeNull();
    const secret = document.createElement('div');
    renderQuestionFields(secret, [{ ...single, options: [], isSecret: true }]);
    expect(secret.querySelector<HTMLInputElement>('.ct-question-other-text')!.type).toBe('password');
  });

  it('gives each form its own radio groups so identical questions on one page do not collide', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    renderQuestionFields(a, [single]);
    renderQuestionFields(b, [single]);
    const nameA = a.querySelector<HTMLInputElement>('input[type=radio]')!.name;
    const nameB = b.querySelector<HTMLInputElement>('input[type=radio]')!.name;
    expect(nameA).not.toBe(nameB);
  });

  it('supports the mobile class set', () => {
    const body = document.createElement('div');
    renderQuestionFields(body, [single], MOBILE_QUESTION_CLASSES);
    expect(body.querySelector('.ct-mobile-question-title')?.textContent).toBe('Pick');
    expect(body.querySelector('.ct-mobile-question-other-text')).not.toBeNull();
  });

  it('restores selections and typed text from a draft after the form is rebuilt', () => {
    const draft: QuestionDraft = { fields: {} };
    const first = document.createElement('div');
    renderQuestionFields(first, [single], undefined, draft);
    first.querySelectorAll<HTMLInputElement>('input[type=radio]')[1].click();
    first.querySelector<HTMLInputElement>('.ct-question-row, .ct-question-option')!.click();
    const text = first.querySelector<HTMLInputElement>('input.ct-question-other-text')!;
    text.value = 'my own';
    text.dispatchEvent(new Event('input', { bubbles: true }));

    const rebuilt = document.createElement('div');
    const collect = renderQuestionFields(rebuilt, [single], undefined, draft);
    expect(rebuilt.querySelector<HTMLInputElement>('input.ct-question-other-text')!.value).toBe('my own');
    expect(collect()['Which?']).toBeTruthy();
  });

  it('never captures secret text into a draft', () => {
    const draft: QuestionDraft = { fields: {} };
    const body = document.createElement('div');
    renderQuestionFields(body, [{ ...single, options: [], isSecret: true }], undefined, draft);
    const text = body.querySelector<HTMLInputElement>('input.ct-question-other-text')!;
    text.value = 'hunter2';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.stringify(draft)).not.toContain('hunter2');
  });
});
