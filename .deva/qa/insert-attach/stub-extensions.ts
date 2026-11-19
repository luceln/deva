/**
 * store/extensions 的桩：Composer 只用 `skills`（/ 联想与上色），且要 `rolesAllow`。
 * 真实 provider 会拉一圈 IPC，这里给空技能表即可——本用例验的是附件，与技能无关。
 */
export function useExtensions(): { skills: unknown[]; mcp: unknown[] } {
  return { skills: [], mcp: [] }
}

export function rolesAllow(): boolean {
  return true
}
