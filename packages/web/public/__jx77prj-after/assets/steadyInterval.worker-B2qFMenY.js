(function(){"use strict";let t=null;self.onmessage=s=>{t&&clearInterval(t),t=null,!(s.data.stop||!s.data.ms)&&(t=setInterval(()=>self.postMessage(0),s.data.ms))}})();
//# sourceMappingURL=steadyInterval.worker-B2qFMenY.js.map
