// `pnpm tools:build [group…]`: builds each tool group's image from tools/ (docs/architecture.md §12).
// The image is tagged <repo>:<hash of its build context>, so the server knows whether it is current.
// Building downloads the pinned base image and tool releases; that is this command's job, never the server's.
import { CatalogError, LABEL_CONTEXT, LABEL_GROUP, TOOLS_DIR, loadCatalog } from './catalog';
import { DockerRuntime } from './docker';

async function main(args: string[]): Promise<number> {
  let catalog;
  try {
    catalog = loadCatalog();
  } catch (e) {
    console.error(e instanceof CatalogError ? e.message : e);
    return 1;
  }
  const unknown = args.filter((a) => !catalog.info(a));
  if (unknown.length > 0) {
    console.error(`unknown group(s): ${unknown.join(', ')}. Groups: ${catalog.groups.map((g) => g.def.name).join(', ')}`);
    return 2;
  }
  const docker = new DockerRuntime();
  const ping = await docker.ping();
  if (!ping.ok) {
    console.error(`✗ ${ping.error}\n  Start Docker Desktop, then run this again.`);
    return 1;
  }

  const groups = args.length > 0 ? args.flatMap((a) => catalog.info(a) ?? []) : catalog.groups;
  let failed = 0;
  for (const group of groups) {
    if (await docker.inspectImage(group.imageRef)) {
      console.log(`✓ ${group.def.name}: ${group.imageRef} is up to date`);
      continue;
    }
    console.log(`… ${group.def.name}: building ${group.imageRef} (${String(group.contextFiles.length)} files from tools/)`);
    const started = Date.now();
    try {
      await docker.build({
        context: TOOLS_DIR,
        files: group.contextFiles,
        dockerfile: group.dockerfile,
        tag: group.imageRef,
        labels: { [LABEL_GROUP]: group.def.name, [LABEL_CONTEXT]: group.contextHash },
        onLog: (line) => {
          console.log(`    ${line}`);
        },
      });
      console.log(`✓ ${group.def.name}: built ${group.imageRef} in ${String(Math.round((Date.now() - started) / 1000))} s`);
    } catch (e) {
      failed += 1;
      console.error(`✗ ${group.def.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2).filter((a) => a !== '--'));
