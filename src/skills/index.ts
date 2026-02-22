import * as fs from 'fs';
import { join } from 'path';
import { minimatch } from 'minimatch';
import { createContextLogger } from '../logger';

const log = createContextLogger('skills');

export interface ISkill {
  name: string;
  description: string;
  trigger_patterns: string[];
  instructions: string;
}

export class ContextAwareSkillLoader {
  private skills: ISkill[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.loadSkills();
    log.debug('ContextAwareSkillLoader initialized', { 
      workspaceRoot, 
      skillsCount: this.skills.length 
    });
  }

  private loadSkills() {
    const skillsDir = join(this.workspaceRoot, '.opencode', 'skills');
    if (!fs.existsSync(skillsDir)) {
      log.debug('Skills directory not found', { path: skillsDir });
      return;
    }

    try {
      const folders = fs.readdirSync(skillsDir);
      for (const folder of folders) {
        const skillPath = join(skillsDir, folder, 'skill.json');
        const instPath = join(skillsDir, folder, 'instructions.md');

        if (fs.existsSync(skillPath) && fs.existsSync(instPath)) {
          try {
            const metadata = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
            const instructions = fs.readFileSync(instPath, 'utf8');

            this.skills.push({
              name: metadata.name || folder,
              description: metadata.description || '',
              trigger_patterns: metadata.trigger_patterns || [],
              instructions,
            });
            log.debug('Loaded skill', { name: metadata.name || folder, patterns: metadata.trigger_patterns });
          } catch (e) {
            log.warn(`Failed to load skill: ${folder}`, e);
          }
        }
      }
      log.info(`Loaded ${this.skills.length} skills`);
    } catch (e) {
      log.error('Error loading skills', e);
    }
  }

  /**
   * Determine if a skill should be active based on recent file paths
   * mentioned in the chat or recently modified in the workspace.
   */
  public getActiveSkills(recentFiles: string[]): ISkill[] {
    const activeSkills = this.skills.filter((skill) => {
      // If no patterns, it's a global skill
      if (!skill.trigger_patterns || skill.trigger_patterns.length === 0) {
        log.debug(`Skill "${skill.name}" is global (no trigger patterns)`);
        return true;
      }

      // Check if any recent file matches any pattern
      const matches = recentFiles.some((file) => 
        skill.trigger_patterns.some((pattern) => minimatch(file, pattern, { dot: true, matchBase: true }))
      );
      
      if (matches) {
        log.debug(`Skill "${skill.name}" triggered by recent files`);
      }
      return matches;
    });

    log.debug(`Active skills: ${activeSkills.length}/${this.skills.length}`);
    return activeSkills;
  }

  public getAllSkills(): ISkill[] {
    return this.skills;
  }
}
