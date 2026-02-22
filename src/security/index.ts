import { createHash } from 'crypto';
import { access, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import * as fs from 'fs';
import { createContextLogger } from '../logger';

const log = createContextLogger('security');

export interface IAuthorizationRecord {
  serverName: string;
  configHash: string;
  contentHash?: string;
  approvedAt: number;
}

export class AuthorizationEngine {
  private cachePath: string;
  private cache: Record<string, IAuthorizationRecord> = {};

  constructor(workspaceRoot: string) {
    // We store the security cache globally or per-workspace.
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    this.cachePath = join(homeDir, '.opencode', 'security_cache.json');
    this.ensureCacheLoaded();
    log.debug('AuthorizationEngine initialized', { workspaceRoot, cachePath: this.cachePath });
  }

  private async ensureCacheLoaded() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = await readFile(this.cachePath, 'utf8');
        // Guard against empty or truncated files (race condition when
        // multiple opencode instances write to the same cache file).
        const trimmed = data.trim();
        if (!trimmed) {
          log.warn('Security cache file is empty, starting fresh');
          this.cache = {};
          return;
        }
        try {
          this.cache = JSON.parse(trimmed);
        } catch (parseErr) {
          log.warn('Security cache file is corrupted (likely concurrent write), starting fresh', {
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            dataLength: data.length,
            dataPreview: data.slice(0, 100),
          });
          this.cache = {};
        }
        log.debug('Security cache loaded', { entries: Object.keys(this.cache).length });
      } else {
        const dir = join(process.env.HOME || '/tmp', '.opencode');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await writeFile(this.cachePath, '{}', 'utf8');
        log.debug('Created new security cache');
      }
    } catch (e) {
      log.warn('Failed to load security cache', e);
    }
  }

  private async saveCache() {
    try {
      await writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
      log.debug('Security cache saved');
    } catch (e) {
      log.error('Failed to save security cache', e);
    }
  }

  public async getFileHash(filePath: string): Promise<string> {
    const content = await readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  public async getConfigHash(command: string, args: string[]): Promise<string> {
    return createHash('sha256')
      .update(JSON.stringify({ command, args }))
      .digest('hex');
  }

  /**
   * Verifies if a local script is authorized. If not, it can throw or log.
   */
  public async verifyAndAuthorize(
    serverName: string,
    command: string,
    args: string[],
    workspaceRoot: string
  ): Promise<boolean> {
    const configHash = await this.getConfigHash(command, args);
    let contentHash: string | undefined;

    // Check if any arg is a local file
    for (const arg of args) {
      // Very naive check for local script path
      if (arg.endsWith('.js') || arg.endsWith('.ts') || arg.endsWith('.py')) {
        const fullPath = arg.startsWith('/') ? arg : join(workspaceRoot, arg);
        try {
          await access(fullPath);
          contentHash = await this.getFileHash(fullPath);
          break; // Use the first script found
        } catch {
          // File does not exist, ignore
        }
      }
    }

    const recordId = `${workspaceRoot}:${serverName}`;
    const record = this.cache[recordId];

    if (record) {
      if (record.configHash === configHash && record.contentHash === contentHash) {
        log.debug('Command already authorized', { serverName, command });
        return true; // Already authorized
      }
    }

    // Need authorization
    log.warn('Security: Local tool configuration or content has changed', {
      serverName,
      command: `${command} ${args.join(' ')}`,
      contentHash,
    });
    
    // Auto-approve in headless or throw error. Here we simulate user prompt by logging
    // For a real CLI, we might use readline or inquirer. We will just auto-update for now
    // but log prominently.
    log.info('Auto-trusting and updating security cache', { serverName });
    
    this.cache[recordId] = {
      serverName,
      configHash,
      contentHash,
      approvedAt: Date.now(),
    };
    await this.saveCache();

    return true;
  }
}
