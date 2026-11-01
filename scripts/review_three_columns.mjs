#!/usr/bin/env node
// scripts/review_three_columns.mjs —— 复算 ① 主刀的三格归属表（只读）。
// 口径：review 代码块内的全部顶层函数，按显式名单分「搬进模块 / 留壳 / 别的域」。
// 用法：node scripts/review_three_columns.mjs   （ROW\t名字\t起\t止\t行数\t格\t备注）
import { readFileSync } from "node:fs";
const src=readFileSync("backend/book2text/static/app.js","utf8").split("\n");
const re=/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const fns=[];
for(let i=0;i<src.length;i++){const m=re.exec(src[i]);if(!m)continue;let d=0,end=i;for(let j=i;j<src.length;j++){for(const ch of src[j]){if(ch==="{")d++;else if(ch==="}")d--;}if(d===0&&j>i){end=j;break;}}fns.push({name:m[1],start:i+1,end:end+1,lines:end-i+1});}
const BLOCKS=[[5466,9030],[9893,10924],[1272,1359],[706,827]];
const inLine=f=>BLOCKS.some(([a,b])=>f.start>=a&&f.start<=b);
const MODULE=new Set(["blockCard","blockDivergenceSection","adoptAllHighSuggestions","renderReviewBlocks","diffCompareLines","patchBlock","diffRowFragment","blockSuggestionBadge","reviewAction","refreshDetailSuggestions","adoptLine","pageNumberHintChip","applyDetailSuggestions","adoptBlockSuggestion","captureEditorFocus","restoreEditorFocus","autoSizeTextarea","flushPendingSave","selectReviewBlock","focusSiblingBlock","scheduleBlockSave","blockNeedsReview","truncate","suggestionHighList","createBlockFromBox","recognizeBoxRegion","drawInkGapMarks","onBoxMouseUp","loadInkGaps","setupBoxCreate","renderInkGapBar","setBoxCreateMode","drawBoxDraft","startRegionRecognition","onBoxMouseDown","normalizedPoint","boxDraftRect","onBoxMouseMove","inkGapBarVisible","renderLayoutPanel","confirmPageLayout","renderSuggestionTools","waitForAuxThenReview","renderAuxiliary","runAuxiliary","openAuxWarning","activeAuxJob","setupAuxControls"]);
const CLEAN=new Set(["renderQueueFooter","renderDiffQueue","openCandidateCompare","renderCandidate","applyCandidateBlock","decideCandidate","applyQueueAckLocally","queueHasPendingItems","buildDiffQueue","queueCounts","nextPendingQueueIndex","queueDotFor","initDiffQueue","adoptQueueCurrent","keepQueueCurrent","previousQueueItem","setQueueOpen","stepReviewDiff","focusQueueItem","queueAckText"]);
const TREE=new Set(["ensureReviewTree","renderReviewTree","setReviewTreeOnlyTodo","syncReviewTreeToPage","treeItemSummary","loadReviewTreeItems","toggleReviewTreeChapter","toggleReviewTreePage","treeLevelLabel","treeChapterOfPage","updateReviewTreeAfterAck","reviewTreeStatsText","openTreeItem","treeItemsFromBlocks"]);
const DRAWER=new Set(["openPageDetail","closePageDetail","loadPageDetail","renderPageDetail","ensureBlockListed","renderReviewWorkflowStatus","renderReviewBanner","renderReviewHeadline","pagerPages","renderReviewPager","setupReviewPager","paintReviewMargin","toggleReviewMargin","drawDetailOverlay","drawDetailLines","renderHistoryButtons","captureQueueSnapshot","restoreQueueAfterUndo","focusQueueBar","fitWidth","applyZoom","setReviewOverlay","setReviewMargin","setupViewerTools","findDiffMark","drawDiffLayer","scrollViewerTo","scrollRowIntoList","syncDiffStrip","updateDiffActive","activateDiff","renderReviewFilter"]);
const FINISH=new Set(["confirmCurrentPage","setupReviewAutoPass","nextUnfinishedPage","openFinishPanel","closeFinishPanel","finishConfirmPages","finishShowFallbackPages","finishRunLayout","finishConfirmLayout","finishStopLayout","finishResumeLayout","finishRunAutoPass","finishStartAutoPass","finishStopAutoPass","finishResumeAutoPass","finishRevokeAutoPass","finishOpenPageNumbers","finishStartReview","finishOpenExport","finishChipText","finishIcon","loadFinishSummary","humanTouchedPages"]);
const OTHER=new Set(["structureAction","undoAutoApply"]);
const cols={module:[],leave:[],other:[]};
const unclassified=[];
for(const f of fns.filter(inLine)){
  if(MODULE.has(f.name))cols.module.push(f);
  else if(CLEAN.has(f.name))cols.other.push({...f,why:"清洗/删"});
  else if(TREE.has(f.name))cols.other.push({...f,why:"树→index"});
  else if(DRAWER.has(f.name))cols.other.push({...f,why:"抽屉域"});
  else if(FINISH.has(f.name))cols.other.push({...f,why:"收尾域"});
  else if(OTHER.has(f.name))cols.other.push({...f,why:"结构/识别域"});
  else cols.leave.push(f);
}
const sum=a=>a.reduce((s,x)=>s+x.lines,0);
console.log("review 线（五个代码块）函数总数 =", cols.module.length+cols.leave.length+cols.other.length);
console.log("搬进模块:",cols.module.length,"/",sum(cols.module));
console.log("留壳:",cols.leave.length,"/",sum(cols.leave));
console.log("别的域:",cols.other.length,"/",sum(cols.other));
console.log("合计:",cols.module.length+cols.leave.length+cols.other.length,"/",sum(cols.module)+sum(cols.leave)+sum(cols.other));
console.log("\n留壳逐个：",cols.leave.map(f=>`${f.name}(${f.lines})`).join(" "));
console.log("\n别的域逐个：");for(const f of cols.other)console.log(`  ${f.name}(${f.lines}) ${f.why}`);
for(const [col,list] of [["搬进模块",cols.module],["留壳",cols.leave],["别的域",cols.other]]) for(const f of list) console.log(`ROW\t${f.name}\t${f.start}\t${f.end}\t${f.lines}\t${col}\t${f.why||""}`);
