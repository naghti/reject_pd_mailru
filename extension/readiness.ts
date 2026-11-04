import type { Letter } from "../src/types";
export function manualReasons(letter: Letter): string[] {
  return [
    ...letter.missing.map((field) => `Заполните: ${field}`),
    ...letter.actions,
  ];
}
export function readyLetters(letters: Letter[]): Letter[] {
  return letters.filter((letter) => manualReasons(letter).length === 0);
}
