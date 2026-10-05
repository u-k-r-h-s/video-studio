const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0..999999 in English words. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ""}`;
  return `${numberToWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${numberToWords(n % 1000)}` : ""}`;
}

/**
 * The text a voice should be given: digits spelled out ("apartment 13" -> "apartment thirteen", "2:30" -> "two thirty", "3.5" ->
 * "three point five"). Captions keep the written form; only the synthesiser input changes, so what is said never depends on a
 * speech model's own number guessing.
 */
export function spokenText(text: string): string {
  return text
    .replace(/(\d{1,2}):(\d{2})\b/g, (_m, h: string, m: string) => (m === "00" ? numberToWords(+h) : `${numberToWords(+h)} ${+m < 10 ? "oh " : ""}${numberToWords(+m)}`))
    .replace(/(\d+)\.(\d+)/g, (_m, a: string, b: string) => `${numberToWords(+a)} point ${[...b].map((d) => ONES[+d]).join(" ")}`)
    .replace(/(\d+)%/g, (_m, a: string) => `${numberToWords(+a)} percent`)
    .replace(/\d{1,6}/g, (m) => numberToWords(+m));
}
