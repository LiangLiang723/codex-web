export function repositorySummary(workspacePath, branchName, isDirty = false) {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty,
    isGitAvailable: true,
    isRepository: true,
  };
}
