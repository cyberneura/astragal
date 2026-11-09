// Adapted from Beckwell (Cyberneura), MIT. See docs/beckwell-chat.md.
// AskUserQuestion (Claude Code が利用者に選択肢を示して尋ねるツール) の入力の解釈と、答えの組み立て
import type { Question, QuestionDraft } from './types';

const QUESTION_KINDS = new Set(['choice', 'text', 'number']);

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ツールの入力から質問を取り出す。質問として解釈できなければ null (普通の権限確認として扱う)
export function parseQuestions(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof entry.question !== 'string' || !entry.question) return null;
    const kind = QUESTION_KINDS.has(entry.kind) ? (entry.kind as Question['kind']) : 'choice';
    const options = Array.isArray(entry.options)
      ? entry.options
          .filter((option: any) => option && typeof option.label === 'string' && option.label)
          .map((option: any) => ({ label: option.label as string, description: typeof option.description === 'string' ? option.description : '' }))
      : [];
    // 選択式なのに選択肢が無い質問と、重複する質問文・選択肢は、Claude Code 自身も拒否する
    // (答えは質問文をキーにして返すので、重複があると片方の答えが消える)
    if (kind === 'choice' && options.length === 0) return null;
    if (questions.some((other) => other.question === entry.question)) return null;
    if (new Set(options.map((option: { label: string }) => option.label)).size !== options.length) return null;
    questions.push({
      question: entry.question,
      header: typeof entry.header === 'string' ? entry.header : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      kind,
      options,
      multiSelect: entry.multiSelect === true,
      placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
      min: optionalNumber(entry.min),
      max: optionalNumber(entry.max),
      step: optionalNumber(entry.step),
      unit: typeof entry.unit === 'string' ? entry.unit : '',
    });
  }
  return questions;
}

export function emptyDraft(question: Question, input: Record<string, unknown>): QuestionDraft {
  const raw = (input.questions as any[])?.find?.((entry) => entry?.question === question.question);
  const initial = optionalNumber(raw?.defaultValue);
  return { selected: [], text: question.kind === 'number' && initial !== null ? String(initial) : '' };
}

// 1 問の答え。答えになっていなければ null。複数選択はカンマ区切り (Claude Code の tool_result と同じ形)
export function formatAnswer(question: Question, draft: QuestionDraft): string | null {
  const text = draft.text.trim();
  if (question.kind === 'text') return text || null;
  if (question.kind === 'number') {
    const value = Number(text);
    if (!text || !Number.isFinite(value)) return null;
    if ((question.min !== null && value < question.min) || (question.max !== null && value > question.max)) return null;
    return text;
  }
  // 単一選択では自由記述が選択肢の代わりになる (toggleOption / setText が両方残さないようにしている)
  const labels = question.options.map((option) => option.label).filter((label) => draft.selected.includes(label));
  if (!question.multiSelect) return text || labels[0] || null;
  // 選択肢の順に並べ、自由記述は最後に足す
  if (text) labels.push(text);
  return labels.length > 0 ? labels.join(', ') : null;
}

// 全問の答え (drafts は questions と同じ並び)。答えていない質問があれば null
export function collectAnswers(questions: Question[], drafts: QuestionDraft[]): Record<string, string> | null {
  // キーは質問文そのもの。"__proto__" という質問でも own property になるよう、プロトタイプの無いオブジェクトに入れる
  const answers: Record<string, string> = Object.create(null);
  for (const [index, question] of questions.entries()) {
    const answer = formatAnswer(question, drafts[index]);
    if (answer === null) return null;
    answers[question.question] = answer;
  }
  return answers;
}

// 選択肢を押した時の選択の切り替え。単一選択は置き換え (同じものを押すと外す) で、自由記述も消す。複数選択は反転
export function toggleOption(question: Question, draft: QuestionDraft, label: string): void {
  if (draft.selected.includes(label)) {
    draft.selected = draft.selected.filter((selected) => selected !== label);
  } else if (question.multiSelect) {
    draft.selected = [...draft.selected, label];
  } else {
    draft.selected = [label];
    draft.text = '';
  }
}

// 入力欄の文字。単一選択では自由記述が選択肢の代わりなので、書き始めたら選択を外す
export function setText(question: Question, draft: QuestionDraft, text: string): void {
  draft.text = text;
  if (question.kind === 'choice' && !question.multiSelect && text) draft.selected = [];
}
