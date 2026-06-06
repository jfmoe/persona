import { homedir } from 'node:os'
import { join } from 'node:path'

/** The persona mask library directory, `~/.persona/`. */
export function personaHome(): string {
  return join(homedir(), '.persona')
}
