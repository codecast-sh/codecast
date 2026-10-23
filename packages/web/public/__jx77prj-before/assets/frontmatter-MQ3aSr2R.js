function i(t){if(!t.startsWith(`---
`)&&!t.startsWith(`---\r
`)&&t!=="---")return 0;const r=t.split(`
`);for(let s=1;s<r.length;s++)if(/^(?:---|\.\.\.)\s*$/.test(r[s]))return s+1;return 0}function n(t){const r=i(t);if(!r)return[null,t];const s=t.split(`
`);return[s.slice(1,r-1).join(`
`),s.slice(r).join(`
`)]}export{i as f,n as s};
//# sourceMappingURL=frontmatter-MQ3aSr2R.js.map
