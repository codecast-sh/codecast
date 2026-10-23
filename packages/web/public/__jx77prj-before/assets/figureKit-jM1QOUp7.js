import{j as a,r as o}from"./vendor-BRSpyZc9.js";import{eR as d}from"./index-BHRaJIHC.js";import{S as t}from"./blogChrome--gDMB-m8.js";const c=`
.bj-draw{stroke-dasharray:1 1;stroke-dashoffset:1}
.bj-pop{opacity:0;transform-box:fill-box;transform-origin:center;transform:scale(.2)}
.bj-fade{opacity:0}
.bj-rise{opacity:0;transform:translateY(6px)}
.bj-grow{transform-box:fill-box;transform-origin:left center;transform:scaleX(0)}
.bj-sweep{opacity:0}
[data-play="1"] .bj-draw{animation:bj-draw var(--dur,.4s) cubic-bezier(.45,0,.25,1) var(--at,0s) forwards}
[data-play="1"] .bj-pop{animation:bj-pop .4s cubic-bezier(.3,1.7,.5,1) var(--at,0s) forwards}
[data-play="1"] .bj-fade{animation:bj-fade .6s ease var(--at,0s) forwards}
[data-play="1"] .bj-rise{animation:bj-rise .5s cubic-bezier(.2,.8,.3,1) var(--at,0s) forwards}
[data-play="1"] .bj-grow{animation:bj-grow var(--dur,.6s) linear var(--at,0s) forwards}
[data-play="1"] .bj-sweep{animation:bj-sweep var(--dur,5s) linear var(--at,0s) forwards}
[data-play="1"] .bj-pulse{animation:bj-pulse 1.6s ease-in-out var(--at,0s) infinite}
@keyframes bj-draw{to{stroke-dashoffset:0}}
@keyframes bj-pop{to{opacity:1;transform:scale(1)}}
@keyframes bj-fade{to{opacity:1}}
@keyframes bj-rise{to{opacity:1;transform:none}}
@keyframes bj-grow{to{transform:scaleX(1)}}
@keyframes bj-sweep{0%{opacity:.9;transform:translateX(0)}97%{opacity:.9}100%{opacity:0;transform:translateX(var(--to))}}
@keyframes bj-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){
  [data-play] *{animation:none!important}
  .bj-draw{stroke-dashoffset:0}.bj-pop,.bj-fade,.bj-rise{opacity:1;transform:none}.bj-grow{transform:none}
}
`;function j(){return a.jsx("style",{children:c})}const y=(r,e,s)=>({"--at":`${r.toFixed(2)}s`,...e!==void 0?{"--dur":`${e.toFixed(2)}s`}:{},...s});function u({children:r,minWidth:e}){const s=o.useRef(null),n=d(s,"0px 0px -20% 0px"),[i,l]=o.useState(0);return a.jsxs("div",{ref:s,className:"relative",children:[a.jsx("div",{className:"flex justify-end px-3 pt-2 sm:absolute sm:top-0 sm:right-0 sm:z-10",children:a.jsx("button",{type:"button",onClick:()=>l(p=>p+1),className:"font-mono text-[11px] px-2 py-0.5 rounded hover:opacity-100 opacity-60 transition-opacity",style:{color:t.base01,backgroundColor:t.base2},children:"replay"})}),a.jsx("div",{className:e?"overflow-x-auto":void 0,children:a.jsx("div",{"data-play":n?"1":"0",style:e?{minWidth:e}:void 0,children:r},i)})]})}function x({title:r,sub:e,color:s}){return a.jsxs("div",{className:"px-5 pt-4",children:[a.jsxs("div",{className:"font-mono text-sm font-bold flex items-center gap-2",style:{color:t.base02},children:[a.jsx("span",{className:"inline-block w-2.5 h-2.5 rounded-sm",style:{backgroundColor:s}}),r]}),a.jsx("div",{className:"text-[13px] mt-1 leading-snug",style:{color:t.base00},children:e})]})}export{j as F,x as P,u as S,y as t};
//# sourceMappingURL=figureKit-jM1QOUp7.js.map
