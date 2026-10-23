import{r as o}from"./vendor-BRSpyZc9.js";const t=new Map;function f(e,a){o.useLayoutEffect(()=>{if(!e)return;const s=a.filter(n=>n.available!==!1);return t.set(e,s),()=>{t.get(e)===s&&t.delete(e)}},[e,a])}function l(e){return t.get(e)??[]}export{l as g,f as u};
//# sourceMappingURL=paletteSessionCommands-uIyum_Ne.js.map
