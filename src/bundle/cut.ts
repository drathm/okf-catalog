/** The first `cap` characters of a text, one fewer when the cut would split a surrogate pair. */
export function cutAt(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const code = text.charCodeAt(cap - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? cap - 1 : cap);
}

/** A text whole within `cap` characters, else its first `cap` (no surrogate pair split) and an ellipsis. */
export const ellipsised = (text: string, cap: number): string =>
  text.length <= cap ? text : `${cutAt(text, cap)}…`;
