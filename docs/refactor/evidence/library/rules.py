"""library 切片的替换口径（move(library) 那一笔）。"""
# 标识符 → 注入调用（左边界挡属性访问）
IDENT = [
    ("apiJson", "injected.apiJson"),
    ("showError", "injected.showError"),
    ("showView", "injected.navigate"),
    ("closeModal", "injected.closeModal"),
    ("openModal", "injected.openModal"),
    ("syncWorkflowSteps", "injected.syncWorkflowSteps"),
    ("closeFinishPanel", "injected.closeFinishPanel"),
    ("updateFinishChips", "injected.updateFinishChips"),
    ("stopTaskPolling", "injected.stopTaskPolling"),
    ("closePageDetail", "injected.closePageDetail"),
    ("closeTaskDrawer", "injected.closeTaskDrawer"),
    ("loadTasks", "injected.loadTasks"),
    ("loadSetupSuggestions", "injected.loadSetupSuggestions"),
    ("loadAutoApplyStatus", "injected.loadAutoApplyStatus"),
    ("loadFinishSummary", "injected.loadFinishSummary"),
    ("applyProjectSettings", "injected.applyProjectSettings"),
    ("fillDefinitionList", "injected.fillDefinitionList"),
    ("renderPages", "injected.renderPages"),
    ("renderRecognitionSettings", "injected.renderRecognitionSettings"),
    ("refreshPageStates", "injected.refreshPageStates"),
    ("refreshProject", "injected.refreshProject"),
    ("schedulePageVisibility", "injected.schedulePageVisibility"),
    ("queueAfterSteps", "injected.queueAfterSteps"),
    ("saveBlob", "injected.saveBlob"),
    ("setSaveState", "injected.setSaveState"),
    ("pageMarginStorageKey", "injected.pageMarginStorageKey"),
    ("pageOverlayStorageKey", "injected.pageOverlayStorageKey"),
    ("reviewMarginStorageKey", "injected.reviewMarginStorageKey"),
    ("libraryProjects", "injected.getLibraryProjects()"),
    ("lockConflictTarget", "injected.getLockConflictTarget()"),
    ("currentProject", "injected.getProject()"),
    ("lastStepPanelKey", "injected.getLastStepPanelKey()"),
    ("workflowStep", "injected.getWorkflowStep()"),
    ("workflowStepPinned", "injected.getWorkflowStepPinned()"),
    ("projectSummary", "injected.getProjectSummary()"),
    ("projectExports", "injected.getProjectExports()"),
    ("workflowSummary", "injected.getWorkflowSummary()"),
    ("workflowConfirmationCounts", "injected.getWorkflowConfirmationCounts()"),
    ("pendingPageNos", "injected.getPendingPageNos()"),
    ("pendingPageCount", "injected.getPendingPageCount()"),
    ("setupSuggestions", "injected.getSetupSuggestions()"),
    ("setupSuggestionsLoaded", "injected.getSetupSuggestionsLoaded()"),
    ("marginSuggestion", "injected.getMarginSuggestion()"),
    ("finishSummary", "injected.getFinishSummary()"),
    ("finishSummaryProject", "injected.getFinishSummaryProject()"),
    ("reviewMarginOn", "injected.getReviewMarginOn()"),
    ("reviewBlockFilter", "injected.getReviewBlockFilter()"),
    ("backupSelected", "injected.getBackupSelected()"),
    ("pageZoomTouched", "injected.getPageZoomTouched()"),
    ("pagesMarginOn", "injected.getPagesMarginOn()"),
    ("pagesOverlayOn", "injected.getPagesOverlayOn()"),
    ("marginFitTried", "injected.getMarginFitTried()"),
    ("marginUndoStack", "injected.getMarginUndoStack()"),
    ("workflowByPageId", "injected.getWorkflowByPageId()"),
    ("LAST_VIEW_LABELS", "injected.lastViewLabels"),
    ("token", "injected.token"),
    # 自检抓出来的 8 个（2026-10-29 第一次干跑：残余接缝 9 个）
    ("loadPageMarginPreference", "injected.loadPageMarginPreference"),
    ("loadPageOverlayPreference", "injected.loadPageOverlayPreference"),
    ("loadReviewMarginPreference", "injected.loadReviewMarginPreference"),
    ("openPageSetup", "injected.openPageSetup"),
    ("resumeLastPosition", "injected.resumeLastPosition"),
    ("bootingProject", "injected.getBootingProject()"),
    # 裁定 B：锁冲突对话框留外壳，模块走注入（画的是全局 modal）
    ("showLockConflict", "injected.showLockConflict"),
]
# 状态写点 → setter（**必须在 IDENT 替换之前跑**，否则会生成 `injected.getX() = v`：
# 那不是语法错误、`node --check` 也照样 PASS（实测 Node 26 的 --check 不查赋值目标），
# 只在运行时炸。2026-10-29 干跑抓到：openProject 里有 11 处）
SETTERS = {
    "libraryProjects": "injected.setLibraryProjects",
    "bootingProject": "injected.setBootingProject",
    "pagesOverlayOn": "injected.setPagesOverlayOn",
    "pagesMarginOn": "injected.setPagesMarginOn",
    "setupSuggestionsLoaded": "injected.setSetupSuggestionsLoaded",
    "setupSuggestions": "injected.setSetupSuggestions",
    "marginSuggestion": "injected.setMarginSuggestion",
    "lastStepPanelKey": "injected.setLastStepPanelKey",
    "pageZoomTouched": "injected.setPageZoomTouched",
    "reviewMarginOn": "injected.setReviewMarginOn",
    "reviewBlockFilter": "injected.setReviewBlockFilter",
}

# 2026-10-29 Chief 裁定 B：锁冲突整块（showLockConflict + 4 个 lock 文案）留外壳——
# 它画的是全局 modal（#lock-conflict-*，不属于任何 <section>），搬进模块必撞 R3。
# 模块改调 injected.showLockConflict。MOVERS 17 → 12（371 → 311 行）。
MOVERS = [
    "progressPercent", "ratioText", "timeAgo", "renderProjectList", "deleteProject",
    "lastPositionText", "recognitionExtra", "reviewExtra", "progressRow",
    "createProjectFromFile", "openProject", "currentProjectName",
]

# 残余接缝白名单：这些名字不是"app.js 顶层符号的裸引用"
RESIDUE_OK = ["project_id"]   # 对象字面量的键：{ project_id: x }
