/**
 * Human artifact-review queue — main-process side.
 *
 * Agents drop a descriptor JSON into <hive>/artifacts/ (see that folder's
 * README.md). This module lists the pending descriptors for the Review panel,
 * reads the referenced files for preview, and records approve/reject decisions:
 * the descriptor is moved into .approved/ or .rejected/ and a response is
 * written back into the originating agent's inbox so it can continue.
 *
 * A directory watcher pushes `hive:artifactsChanged` to the renderer so the
 * queue and its tab badge stay live without polling.
 */
import { readdir, readFile, writeFile, rename, mkdir, stat, unlink } from 'node:fs/promises';
import { watch, type FSWatcher, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { imageMimeForPath } from '../shared/imageTypes';
import type { ArtifactDescriptor, ArtifactStatus } from '../shared/artifacts';

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB — same ceiling as the fs text reader
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — same ceiling as the fs binary reader

const artifactsDir = (hiveRoot: string): string => join(hiveRoot, 'artifacts');

/** Best-effort validation that a parsed object is a usable descriptor. A file
 *  that isn't one (half-written, wrong shape) is skipped rather than crashing
 *  the whole list. */
function asDescriptor(raw: unknown): ArtifactDescriptor | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.type !== 'string') return null;
  if (typeof o.filePath !== 'string') return null;
  if (typeof o.agentId !== 'string' || !o.agentId) return null;
  const type = o.type as ArtifactDescriptor['type'];
  if (type !== 'image' && type !== 'plan' && type !== 'doc' && type !== 'design') return null;
  const status = (o.status === 'approved' || o.status === 'rejected') ? o.status : 'pending';
  return {
    id: o.id,
    type,
    title: typeof o.title === 'string' ? o.title : o.id,
    description: typeof o.description === 'string' ? o.description : '',
    filePath: o.filePath,
    agentId: o.agentId,
    agentName: typeof o.agentName === 'string' ? o.agentName : undefined,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date(0).toISOString(),
    status,
    note: typeof o.note === 'string' ? o.note : undefined
  };
}

export async function ensureDirs(hiveRoot: string): Promise<void> {
  const dir = artifactsDir(hiveRoot);
  await mkdir(join(dir, '.approved'), { recursive: true });
  await mkdir(join(dir, '.rejected'), { recursive: true });
}

/** Pending descriptors at the top level of <hive>/artifacts/, newest first.
 *  Dot-subdirectories (.approved, .rejected) are skipped by the readdir filter
 *  below (they are directories, not *.json files). */
export async function list(hiveRoot: string): Promise<ArtifactDescriptor[]> {
  const dir = artifactsDir(hiveRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ArtifactDescriptor[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const abs = join(dir, name);
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      const parsed = asDescriptor(JSON.parse(await readFile(abs, 'utf8')));
      if (parsed && parsed.status === 'pending') out.push(parsed);
    } catch {
      // half-written or malformed — skip, the next watch tick re-lists.
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

/** Locate the on-disk descriptor file for `id`, returning its parsed form and
 *  absolute path. Matches on the `id` field, not the filename. */
async function findOnDisk(hiveRoot: string, id: string): Promise<{ descriptor: ArtifactDescriptor; path: string } | null> {
  const dir = artifactsDir(hiveRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const abs = join(dir, name);
    try {
      const s = await stat(abs);
      if (!s.isFile()) continue;
      const parsed = asDescriptor(JSON.parse(await readFile(abs, 'utf8')));
      if (parsed && parsed.id === id) return { descriptor: parsed, path: abs };
    } catch {
      // skip
    }
  }
  return null;
}

/** Read the artifact's text file for preview (plan/doc). Same guards the fs text
 *  reader uses: size cap and null-byte binary sniff. */
export async function readText(hiveRoot: string, id: string): Promise<
  { ok: true; content: string } | { ok: false; error: string }
> {
  const found = await findOnDisk(hiveRoot, id);
  if (!found) return { ok: false, error: 'artifact not found' };
  try {
    const s = await stat(found.descriptor.filePath);
    if (!s.isFile()) return { ok: false, error: 'not a regular file' };
    if (s.size > MAX_TEXT_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await readFile(found.descriptor.filePath);
    if (buf.includes(0)) return { ok: false, error: 'binary file (not displayable)' };
    return { ok: true, content: buf.toString('utf8') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read the artifact's bytes for image preview. The renderer cannot load a
 *  `file:` URL under the CSP, so the bytes travel over IPC and become a `blob:`
 *  URL there — the same path the fs binary reader takes. */
export async function readImage(hiveRoot: string, id: string): Promise<
  { ok: true; bytes: Uint8Array; mime: string } | { ok: false; error: string }
> {
  const found = await findOnDisk(hiveRoot, id);
  if (!found) return { ok: false, error: 'artifact not found' };
  try {
    const s = await stat(found.descriptor.filePath);
    if (!s.isFile()) return { ok: false, error: 'not a regular file' };
    if (s.size > MAX_IMAGE_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await readFile(found.descriptor.filePath);
    if (buf.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: 'file grew past the size limit while reading' };
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    return { ok: true, bytes, mime: imageMimeForPath(found.descriptor.filePath) ?? 'application/octet-stream' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Absolute path of the artifact file for `id`, so the caller can reveal it in
 *  the OS file browser (the `design` preview's "open in OS"). */
export async function filePathOf(hiveRoot: string, id: string): Promise<string | null> {
  const found = await findOnDisk(hiveRoot, id);
  return found ? found.descriptor.filePath : null;
}

/** Record an approve/reject: stamp the descriptor, move it into the matching
 *  archive folder, and deliver the decision to the agent's inbox. */
export async function decide(
  hiveRoot: string,
  id: string,
  status: Exclude<ArtifactStatus, 'pending'>,
  note?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const found = await findOnDisk(hiveRoot, id);
  if (!found) return { ok: false, error: 'artifact not found' };
  const trimmedNote = typeof note === 'string' && note.trim() ? note.trim() : undefined;
  const updated: ArtifactDescriptor = { ...found.descriptor, status, note: trimmedNote };
  try {
    await ensureDirs(hiveRoot);
    const target = join(artifactsDir(hiveRoot), status === 'approved' ? '.approved' : '.rejected', `${id}.json`);
    await writeFile(target, JSON.stringify(updated, null, 2), 'utf8');
    // Remove the original pending file. rename would be cheaper, but the source
    // filename may differ from `<id>.json`, so write-then-unlink is the reliable
    // move here.
    if (found.path !== target) {
      try { await unlink(found.path); } catch { /* already gone — fine */ }
    }
    await deliverDecision(hiveRoot, updated);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function deliverDecision(hiveRoot: string, descriptor: ArtifactDescriptor): Promise<void> {
  const inbox = join(hiveRoot, 'agents', descriptor.agentId, 'inbox');
  await mkdir(inbox, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const approved = descriptor.status === 'approved';
  const verb = approved ? 'approved' : 'rejected';
  const bodyLines = [
    `Your artifact "${descriptor.title}" (${descriptor.type}, id ${descriptor.id}) was ${verb} in human review.`,
    `File: ${descriptor.filePath}`
  ];
  if (descriptor.note) bodyLines.push(`Reviewer note: ${descriptor.note}`);
  const message = {
    id: randomUUID(),
    conversation: `artifact-${descriptor.id}`,
    in_reply_to: null,
    from: 'human',
    to: descriptor.agentId,
    act: 'response',
    subject: `Artifact ${verb}: ${descriptor.title}`,
    body: bodyLines.join('\n'),
    priority: 'normal',
    hops: 0,
    requires_reply: false,
    needs_human: false,
    created_at: now.toISOString(),
    artifact: { id: descriptor.id, status: descriptor.status, note: descriptor.note ?? null }
  };
  await writeFile(join(inbox, `${stamp}-artifact-${verb}.json`), JSON.stringify(message, null, 2), 'utf8');
}

let watcher: FSWatcher | null = null;
let watchedDir: string | null = null;

/** Start (or re-point) the directory watcher. Idempotent per directory:
 *  re-calling with the same hiveRoot is a no-op. Coalesces bursts of file
 *  events into a single debounced `onChange`. */
export function startWatch(hiveRoot: string, onChange: () => void): void {
  const dir = artifactsDir(hiveRoot);
  if (watcher && watchedDir === dir) return;
  stopWatch();
  try {
    mkdirSync(join(dir, '.approved'), { recursive: true });
    mkdirSync(join(dir, '.rejected'), { recursive: true });
  } catch { /* best effort */ }
  let debounce: ReturnType<typeof setTimeout> | null = null;
  try {
    watcher = watch(dir, (_event, filename) => {
      // Non-recursive watch: subdir writes (.approved/.rejected) don't fire here.
      // A null filename (some platforms) still means something changed — refresh.
      if (filename && !filename.toLowerCase().endsWith('.json')) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(onChange, 150);
    });
    watchedDir = dir;
  } catch (e) {
    console.error('[artifacts] watch failed:', e);
    watcher = null;
    watchedDir = null;
  }
}

export function stopWatch(): void {
  if (watcher) {
    try { watcher.close(); } catch { /* already closed */ }
    watcher = null;
    watchedDir = null;
  }
}
