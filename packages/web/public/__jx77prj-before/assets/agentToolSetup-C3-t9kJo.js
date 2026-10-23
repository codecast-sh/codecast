const s=["browser","computer"];function c(n){return typeof n=="string"&&s.includes(n)}const r="⁢cast:setup ",o=/^[ \t]*\u2062cast:setup (\w+)\u2062[ \t]*$/gm;function i(n){return!!n&&n.includes(r)}function p(n){if(!n||!n.includes(r))return{tool:null,text:n};let t=null;const u=n.replace(o,(l,e)=>(c(e)&&(t=e),""));return{tool:t,text:u.replace(/\n{3,}/g,`

`).trimEnd()}}export{p as e,i as h,c as i};
//# sourceMappingURL=agentToolSetup-C3-t9kJo.js.map
