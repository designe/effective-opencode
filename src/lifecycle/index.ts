import { ChildProcess } from 'child_process';

export class ProcessLifecycleManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private isShuttingDown = false;

  constructor() {
    this.setupTeardownHooks();
  }

  public register(name: string, child: ChildProcess): void {
    if (this.isShuttingDown) {
      child.kill('SIGTERM');
      return;
    }
    
    this.activeProcesses.set(name, child);
    
    child.on('exit', () => {
      this.activeProcesses.delete(name);
    });
  }

  public get(name: string): ChildProcess | undefined {
    return this.activeProcesses.get(name);
  }

  private setupTeardownHooks() {
    const teardown = () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      
      for (const [name, process] of this.activeProcesses.entries()) {
        if (!process.killed && process.pid) {
          try {
            process.kill('SIGTERM'); // 1st Graceful Shutdown
            setTimeout(() => {
              if (!process.killed) {
                process.kill('SIGKILL'); // 2nd Hard Kill
              }
            }, 1000).unref();
          } catch (e) {
            // Ignore kill errors
          }
        }
      }
      this.activeProcesses.clear();
    };

    // Attach to multiple process exit signals
    process.once('exit', teardown);
    process.once('SIGINT', () => { teardown(); process.exit(1); });
    process.once('SIGTERM', () => { teardown(); process.exit(1); });
  }
}

// Export a singleton instance for the plugin
export const lifecycleManager = new ProcessLifecycleManager();
