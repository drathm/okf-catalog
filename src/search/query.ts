/**
 * From a question to the terms the engine receives. qmd ANDs every term as a prefix, treats a leading hyphen as
 * a negation, and turns a run of Chinese, Japanese or Korean characters into one exact phrase, so the question
 * is cut into safe tokens here: letters and digits with internal hyphens, two or more characters, stopwords and
 * question words removed, CJK runs split into overlapping pairs so the relaxed rung has something to relax.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but nor so yet if then else than as of at by for from in into on onto to with without within " +
    "about above across after against along among around before behind below beneath beside between beyond during " +
    "except inside near off out outside over past since through throughout toward towards under until up upon via " +
    "i me my mine we us our ours you your yours he him his she her hers it its they them their theirs this that these " +
    "those who whom whose which what when where why how whether while each every all any both few more most other " +
    "some such no not only own same too very just also ever never here there now again further once " +
    "am is are was were be been being have has had having do does did doing done will would shall should can could " +
    "may might must ought get got gets getting give gives tell tells show shows let lets please thanks " +
    "something anything nothing everything someone anyone"
  ).split(/\s+/),
);

const MAX_TERMS = 12;
const TOKEN = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function pairs(run: string): string[] {
  const chars = [...run];
  if (chars.length < 2) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i] ?? ""}${chars[i + 1] ?? ""}`);
  return out;
}

/** Lower-cased content tokens in question order; CJK runs become overlapping pairs; nothing shorter than two code points. */
export function tokenize(question: string): string[] {
  const tokens: string[] = [];
  for (const raw of question.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const trimmed = raw.replace(/^-+|-+$/g, "");
    if (trimmed.length === 0) continue;
    if (CJK.test(trimmed)) {
      for (const run of trimmed.match(CJK_RUN) ?? []) {
        if (CJK.test(run)) tokens.push(...pairs(run));
        else if (TOKEN.test(run) && [...run].length >= 2) tokens.push(run);
      }
      continue;
    }
    if (!TOKEN.test(trimmed) || [...trimmed].length < 2) continue;
    tokens.push(trimmed);
  }
  return tokens;
}

export function normaliseQuestion(question: string): { terms: string[]; dropped: string[] } {
  const terms: string[] = [];
  const dropped: string[] = [];
  for (const token of tokenize(question)) {
    if (STOPWORDS.has(token)) {
      dropped.push(token);
      continue;
    }
    if (terms.includes(token)) continue;
    terms.push(token);
  }
  return { terms: terms.slice(0, MAX_TERMS), dropped };
}
