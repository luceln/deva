/** store/extensions 桩：blocks.tsx 会读 skills；本用例不验技能。 */
export function useExtensions() {
  return { skills: [], mcp: [] }
}
export function rolesAllow() {
  return true
}
