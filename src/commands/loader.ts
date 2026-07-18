import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface CustomCommand {
  name: string
  body: string
}

/** A command contributed by a plugin — absolute path to a .md prompt file.
 *  plugin-loader resolves these from manifest.commands; loadCustomCommands
 *  merges them with project-level .rivet/commands/*.md. */
export interface PluginCommand {
  name: string
  /** Absolute path to the .md file inside the plugin directory. */
  file: string
}

const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Load custom slash commands. Merges project commands (.rivet/commands/*.md)
 *  with plugin-contributed commands (absolute .md paths from plugin-loader).
 *  Project commands take precedence on name collision (loaded first). */
export function loadCustomCommands(cwd: string, pluginCommands?: PluginCommand[]): CustomCommand[] {
  const dir = join(cwd, '.rivet', 'commands')
  const projectCommands: CustomCommand[] = []
  if (existsSync(dir)) {
    const projectRaw = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => ({
        name: basename(entry.name, '.md'),
        fileName: entry.name,
      }))
      .filter(command => COMMAND_NAME_RE.test(command.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(command => ({
        name: command.name,
        body: readFileSync(join(dir, command.fileName), 'utf8'),
      }))
    projectCommands.push(...projectRaw)
  }

  // Merge plugin commands (project takes precedence on name collision).
  const seenNames = new Set(projectCommands.map(c => c.name))
  for (const pc of pluginCommands ?? []) {
    if (seenNames.has(pc.name)) continue
    if (!COMMAND_NAME_RE.test(pc.name)) continue
    if (!existsSync(pc.file)) continue
    try {
      projectCommands.push({ name: pc.name, body: readFileSync(pc.file, 'utf8') })
      seenNames.add(pc.name)
    } catch {
      // skip unreadable plugin command file
    }
  }

  return projectCommands
}

export function resolveCustomCommand(cwd: string, input: string, pluginCommands?: PluginCommand[]): string | null {
  const match = input.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  const [, name, args = ''] = match
  const command = loadCustomCommands(cwd, pluginCommands).find(candidate => candidate.name === name)
  if (!command) return null

  return command.body.replaceAll('$ARGUMENTS', args)
}
