/** A code fence one backtick longer than the longest run inside `text`, so the text cannot close it. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function fenced(text: string): string {
  const f = fenceFor(text);
  return `${f}\n${text}\n${f}`;
}
