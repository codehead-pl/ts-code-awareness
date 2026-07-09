// Stable, position-independent identifiers.
//   fileId   = <packageName>|<relPath>
//   symbolId = <packageName>|<relPath>|<symbolPath>

export const SEP = "|";

export function fileId(pkg: string, relPath: string): string {
  return `${pkg}${SEP}${relPath}`;
}

export function symbolId(pkg: string, relPath: string, symbolPath: string): string {
  return `${pkg}${SEP}${relPath}${SEP}${symbolPath}`;
}
