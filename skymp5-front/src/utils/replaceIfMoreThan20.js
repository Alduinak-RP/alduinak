// Keeps the first `max` occurrences of `substring` as-is and replaces every
// occurrence beyond that with `newString`.
export const replaceIfMoreThan20 = (str, substring, newString, max) => {
  const parts = str.split(substring);
  if (parts.length - 1 <= max) return str;
  return parts.slice(0, max + 1).join(substring) + newString + parts.slice(max + 1).join(newString);
};
