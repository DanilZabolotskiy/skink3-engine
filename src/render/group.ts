import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const CONFIG = '.skink3-render.json';

function groupName(value: string, source: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 256 || /[\u0000-\u001f]/.test(name)) {
    throw new Error(source + ' requires a group of 1 to 256 characters without control characters');
  }
  return name;
}

/** A linked checkout can already be active when the policy is committed to its primary checkout. */
function projectConfig(dir: string): string {
  const local = join(dir, CONFIG);
  if (existsSync(local)) return local;
  const git = join(dir, '.git');
  if (!existsSync(git) || !statSync(git).isFile()) return local;
  const gitDir = /^gitdir:\s+(.+?)\s*$/.exec(readFileSync(git, 'utf8'))?.[1];
  if (!gitDir) return local;
  const state = resolve(dir, gitDir);
  const pointer = join(state, 'commondir');
  if (!existsSync(pointer)) return local;
  const common = resolve(state, readFileSync(pointer, 'utf8').trim());
  return basename(common) === '.git' ? join(dirname(common), CONFIG) : local;
}

/** A checkout can match relative scene paths, so equivalent worktrees and language paths share a group. */
export function renderGroup(scene: string, explicit = process.env['SKINK3_RENDER_GROUP']): string {
  if (explicit !== undefined) return groupName(explicit, 'The render group');
  const file = resolve(scene);
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const config = projectConfig(dir);
    if (existsSync(config)) {
      const { namespace, groups } = JSON.parse(readFileSync(config, 'utf8')) as {
        namespace?: unknown;
        groups?: unknown;
      };
      if (typeof namespace !== 'string' || !Array.isArray(groups)) {
        throw new Error(config + ' must specify a namespace and a groups array');
      }
      const path = relative(dir, file).split(sep).join('/');
      const prefix = groupName(namespace, config);
      for (const rule of groups as { path?: unknown; group?: unknown }[]) {
        if (!rule || typeof rule.path !== 'string' || typeof rule.group !== 'string') {
          throw new Error(config + ' group rules require path and group strings');
        }
        const pattern = new RegExp(rule.path, process.platform === 'win32' ? 'i' : '');
        const match = pattern.exec(path);
        if (!match) continue;
        const key = rule.group.replace(/\$(\d+)/g, (_, index: string) => {
          const value = match[Number(index)];
          if (!value) throw new Error(config + ' group names an empty capture ' + index);
          return value;
        });
        return groupName(prefix + ':' + (process.platform === 'win32' ? key.toLowerCase() : key), config);
      }
      break;
    }
    if (dir === dirname(dir) || existsSync(join(dir, '.git'))) break;
  }
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  return 'scene:' + createHash('sha256').update(key).digest('hex').slice(0, 32);
}
