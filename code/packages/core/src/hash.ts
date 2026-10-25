/**
 * Dependency-free content hash (four FNV-1a lanes). Used for read-before-write
 * state checks in @syaocode/tools; the kernel intentionally imports no Node
 * builtins (report E1). A content-addressed evidence store that needs a
 * cryptographic digest lives in @syaocode/node instead.
 */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b);
    h3 = Math.imul(h3 ^ (c + i), 0xc2b2ae35);
    h4 = Math.imul(h4 + (c ^ (i * 31)), 0x27d4eb2f);
  }
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
