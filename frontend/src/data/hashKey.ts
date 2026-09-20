export function stripArtist(tag: string) {
  let t = String(tag || "");
  while (/^artist\s*:\s*/i.test(t)) t = t.replace(/^artist\s*:\s*/i, "");
  return t.trim();
}

export function tagKey(tag: string) {
  return stripArtist(tag)
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
}
