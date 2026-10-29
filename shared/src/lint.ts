// Non-fatal checks: the "warn" lines of tools/validate_output.py.
import type { ContractFile } from './contract';
import type { NodeType } from './enums';

const NEEDS_SEVERITY: readonly NodeType[] = ['vulnerability', 'secret', 'leak'];
const MAY_BE_ROOT: readonly NodeType[] = ['domain', 'subdomain', 'ip', 'url'];

export function lintContract(doc: ContractFile): string[] {
  const warnings: string[] = [];

  if (doc.status === 'failed' && doc.errors.length === 0) {
    warnings.push("status is 'failed' but 'errors' is empty; say what went wrong");
  }

  const seen = new Set<string>();
  doc.findings.forEach((f, i) => {
    const where = `findings[${String(i)}]`;

    const key = JSON.stringify([f.type, f.value, f.parent ? [f.parent.type, f.parent.value] : null]);
    if (seen.has(key)) {
      warnings.push(`${where}: duplicate finding ${f.type} '${f.value}' with the same parent`);
    }
    seen.add(key);

    if (NEEDS_SEVERITY.includes(f.type) && f.severity === undefined) {
      warnings.push(`${where}: ${f.type} has no severity`);
    }
    if (f.parent == null && !MAY_BE_ROOT.includes(f.type)) {
      warnings.push(`${where}: ${f.type} has no parent; it will float alone on the graph`);
    }
  });

  if (doc.findings.length === 0 && doc.status === 'success') {
    warnings.push('no findings; fine if the tool really found nothing');
  }

  return warnings;
}
