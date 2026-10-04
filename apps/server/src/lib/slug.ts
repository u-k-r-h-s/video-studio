/** "Dadaji Dev!" -> "dadaji-dev"; with sep "_": "Village Shop" -> "village_shop". */
export function slugify(input: string, sep: "-" | "_" = "-"): string {
  const cut = (s: string) => s.replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "");
  const slug = cut(
    input
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, sep),
  );
  return cut(slug.slice(0, 48));
}
