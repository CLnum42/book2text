#!/usr/bin/env node
// scripts/review_a_prime.mjs —— 复算 review-ledger 的 A / A′（只读）。
// 口径：只碰 #view-review id 的函数（三取法 + 字符串字面量，剥注释）；A′ = A − 9 非 review − 4 树。
// 用法：node scripts/review_a_prime.mjs   （输出各段合计 + 59 行可粘贴表格）
import { readFileSync } from "node:fs";
const APP="backend/book2text/static/app.js";
const HTML="backend/book2text/static/index.html";
const src=readFileSync(APP,"utf8"), html=readFileSync(HTML,"utf8");
function strip(s){const out=s.split("");const n=s.length;let i=0;const blank=(a,b)=>{for(let k=a;k<b;k++)if(out[k]!=="\n")out[k]=" ";};
const P="([{=,:;!&|?+-*%~^<>";const looks=(at)=>{let k=at-1;while(k>=0&&/\s/.test(s[k]))k--;if(k<0)return true;return P.includes(s[k]);};
while(i<n){const ch=s[i],nx=s[i+1];
if(ch==="/"&&nx==="/"){const e=s.indexOf("\n",i);const t=e===-1?n:e;blank(i,t);i=t;}
else if(ch==="/"&&nx==="*"){const e=s.indexOf("*/",i+2);const t=e===-1?n:e+2;blank(i,t);i=t;}
else if(ch==="/"&&looks(i)){let k=i+1,c=false;while(k<n){const q=s[k];if(q==="\\"){k+=2;continue;}if(q==="[")c=true;else if(q==="]")c=false;else if(q==="/"&&!c){k++;break;}else if(q==="\n")break;k++;}blank(i,k);i=k;}
else if(ch==="'"||ch==='"'||ch==="`"){const q=ch;let k=i+1;while(k<n){if(s[k]==="\\"){k+=2;continue;}if(s[k]===q){k++;break;}k++;}i=k;}
else i++;}return out.join("");}
const st=strip(src), lines=st.split("\n");
const re=/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const fns=[];
for(let i=0;i<lines.length;i++){const m=re.exec(lines[i]);if(!m)continue;let d=0,end=i;for(let j=i;j<lines.length;j++){for(const ch of lines[j]){if(ch==="{")d++;else if(ch==="}")d--;}if(d===0&&j>i){end=j;break;}}fns.push({name:m[1],start:i+1,end:end+1,lines:end-i+1,body:lines.slice(i,end+1).join("\n")});}
function idsOf(name){const m=new RegExp(`<section\\b[^>]*\\bid="${name}"[^>]*>`,"i").exec(html);if(!m)return new Set();let depth=1;const c=m.index+m[0].length;for(const t of html.slice(c).matchAll(/<(\/?)section\b/gi)){depth+=t[1]?-1:1;if(depth===0){const sl=html.slice(m.index,c+t.index+t[0].length);return new Set([...sl.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));}}return new Set();}
const review=idsOf("view-review");
const other=new Set(["view-pages","view-reading","view-index","view-preview","view-merge","view-library"].flatMap(n=>[...idsOf(n)]));
function idsIn(body){const s=new Set();for(const m of body.matchAll(/\bel\(\s*["']([^"']+)["']\s*\)/g))s.add(m[1]);for(const m of body.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g))s.add(m[1]);for(const m of body.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)[^"']*["']\s*\)/g))s.add(m[1]);for(const m of body.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)){const v=m[1]??m[2];if(v&&(review.has(v)||other.has(v)))s.add(v);}return s;}
const A=[];
for(const f of fns){const ids=idsIn(f.body);const r=[...ids].filter(x=>review.has(x));if(!r.length)continue;const o=[...ids].filter(x=>other.has(x));if(o.length)continue;A.push(f);}
const B5=["boot","setupShell","setupLibrary","applyPackageMode","renderFinishPanel"];
const REMOVE_IN_A=["showView","runAuxiliary","renderAuxiliary","setupAuxControls","confirmCurrentPage","applyQueueAckLocally","structureAction","undoAutoApply","openPageDetail"];
const TREE=["ensureReviewTree","renderReviewTree","setReviewTreeOnlyTodo","syncReviewTreeToPage"];
const Aledger=A.filter(f=>!B5.includes(f.name)&&f.name!=="blockCard");
const Ap=Aledger.filter(f=>!REMOVE_IN_A.includes(f.name)&&!TREE.includes(f.name));
console.log("A(含假阳性) =",A.length,"/",A.reduce((s,x)=>s+x.lines,0));
console.log("A(ledger) =",Aledger.length,"/",Aledger.reduce((s,x)=>s+x.lines,0));
console.log("移除（在 A 里）:", REMOVE_IN_A.filter(n=>A.some(f=>f.name===n)).length, "/", A.filter(f=>REMOVE_IN_A.includes(f.name)).reduce((s,x)=>s+x.lines,0));
console.log("移除（树）:", TREE.filter(n=>A.some(f=>f.name===n)).length, "/", A.filter(f=>TREE.includes(f.name)).reduce((s,x)=>s+x.lines,0));
console.log("A′ =",Ap.length,"/",Ap.reduce((s,x)=>s+x.lines,0));
for(const f of Ap) console.log(`| ${f.name} | ${f.start}–${f.end} | ${f.lines} |`);
