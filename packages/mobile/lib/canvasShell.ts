import { DOMPURIFY_SOURCE } from './vendor/dompurifySource';
import { CANVAS_POLICY_SOURCE } from './vendor/canvasPolicySource';

// Matches web's canvasSanitize.ts policy. <use> is off DOMPurify's default
// allowlist (it can pull external content); we re-allow it and the shell script
// below strips any <use> whose href isn't a same-document "#id" reference.
const PURIFY_CONFIG = JSON.stringify({
  // Body-context parse: without it a LEADING <style> is hoisted into <head> and
  // dropped, since only <body> is serialized back. See canvasSanitize.ts.
  FORCE_BODY: true,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form', 'meta', 'link'],
  FORBID_ATTR: ['ping', 'formaction', 'onclick', 'srcset', 'srcdoc'],
  ADD_TAGS: ['use'],
  ADD_ATTR: ['target'],
});

// Origins whose images may render inside a canvas, injected into the WebView
// sanitize script as a JS array literal.


// --sol-* tokens bridged from the app theme so canvases authored against
// codecast's palette render native-looking, same as web.
// The document shell: tokens + base styles, vendored DOMPurify, then our
// injector script. Raw agent HTML rides in as a JSON string literal — it is
// never parsed as markup until DOMPurify has cleaned it.
export function buildCanvasShell(code: string, tokensCss: string, convexOrigin: string): string {
  const TRUSTED_IMG_ORIGINS_JS = JSON.stringify([convexOrigin]);
  // Escape "<" so a literal "</script>" (or "<!--") inside the agent HTML can't
  // terminate the shell's script block — the HTML parser doesn't know about JS
  // string boundaries.
  const raw = JSON.stringify(code).replace(/</g, '\\u003C');
  const documentShell = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
  :root{${tokensCss}}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:transparent}
  body{color:var(--sol-text);font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;padding:12px;overflow-wrap:break-word}
  a{color:var(--sol-blue)}
  img,svg,video{max-width:100%}
  .cast-chart{border:1px dashed var(--sol-border-light);border-radius:6px;padding:14px;color:var(--sol-text-dim);font-size:12px;text-align:center}
  .cast-tabs-bar{display:flex;gap:2px;border-bottom:1px solid var(--sol-border);margin-bottom:10px;flex-wrap:wrap}
  .cast-tabs-bar button{appearance:none;background:none;border:none;border-bottom:2px solid transparent;padding:5px 10px;margin-bottom:-1px;font:inherit;font-size:12px;color:var(--sol-text-muted)}
  .cast-tabs-bar button[aria-selected=true]{color:var(--sol-text);border-bottom-color:var(--sol-blue)}
  .cast-tabs>section[hidden]{display:none}
  .cast-table th{user-select:none;white-space:nowrap}
  .cast-table th[data-sort]:after{content:' \\2191';color:var(--sol-blue)}
  .cast-table th[data-sort=desc]:after{content:' \\2193'}
</style>
<script>${DOMPURIFY_SOURCE}\n${CANVAS_POLICY_SOURCE}</script>
</head><body><div id="root"></div>
<script>
(function(){
  // Same egress rules as web's canvasSanitize.ts: no scripts (DOMPurify), no
  // third-party network fetches — remote images and CSS url()/@import are
  // scrubbed so a synced canvas can't phone home from a teammate's phone.
  // Images on our own Convex storage origin (cast image uploads, pasted
  // transcript images) are the one carve-out, matching web.
  var TRUSTED_IMG_ORIGINS = ${TRUSTED_IMG_ORIGINS_JS};
  function trustedImgSrc(src){
    if (src.indexOf('data:') === 0) return true;
    var m = /^(https?:\\/\\/[^\\/?#]+)(?:[\\/?#]|$)/i.exec(src);
    return !!m && TRUSTED_IMG_ORIGINS.indexOf(m[1].toLowerCase()) !== -1;
  }
  function scrubCss(css, context){ return globalThis.sanitizeCanvasCss(css, context || 'stylesheet'); }
  var URL_ATTRS = ['mask', 'filter', 'clip-path', 'fill', 'stroke'];
  DOMPurify.addHook('afterSanitizeAttributes', function(node){
    var tag = node.tagName ? node.tagName.toLowerCase() : '';
    var href;
    if (tag === 'use') {
      href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (href.charAt(0) !== '#' && node.parentNode) node.parentNode.removeChild(node);
    }
    if (tag === 'image') {
      href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (!trustedImgSrc(href) && node.parentNode) node.parentNode.removeChild(node);
    }
    if (tag === 'img') {
      var src = node.getAttribute('src') || '';
      if (!trustedImgSrc(src) && node.parentNode) node.parentNode.removeChild(node);
    }
    ['src', 'poster', 'background'].forEach(function(attr){ var v = node.getAttribute(attr); if (v && !trustedImgSrc(v)) node.removeAttribute(attr); });
    URL_ATTRS.forEach(function(attr){
      var v = node.getAttribute && node.getAttribute(attr);
      if (v) node.setAttribute(attr, scrubCss(v, 'value'));
    });
    var style = node.getAttribute && node.getAttribute('style');
    if (style) node.setAttribute('style', scrubCss(style, 'declarationList'));
  });
  DOMPurify.addHook('afterSanitizeElements', function(node){
    if (node.tagName && node.tagName.toLowerCase() === 'style' && node.textContent) {
      var clean = scrubCss(node.textContent);
      if (clean !== node.textContent) node.textContent = clean;
    }
  });
  var clean = DOMPurify.sanitize(${raw}, ${PURIFY_CONFIG});
  var root = document.getElementById('root');
  root.innerHTML = clean;
  // Charts need Observable Plot (web-only for now); show what they are instead
  // of an empty hole.
  root.querySelectorAll('.cast-chart').forEach(function(el){
    el.textContent = 'chart \\u2014 view on web';
  });
  // Widgets — same markup contract as web's castWidgets.ts, vanilla here.
  root.querySelectorAll('.cast-tabs').forEach(function(tabs){
    var panels = Array.prototype.filter.call(tabs.children, function(c){
      return c.tagName === 'SECTION' && c.hasAttribute('data-tab');
    });
    if (panels.length < 2) return;
    var bar = document.createElement('div');
    bar.className = 'cast-tabs-bar';
    function select(active){
      panels.forEach(function(p, i){ p.hidden = i !== active; });
      Array.prototype.forEach.call(bar.children, function(b, i){
        b.setAttribute('aria-selected', String(i === active));
      });
    }
    panels.forEach(function(panel, i){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = panel.getAttribute('data-tab') || ('Tab ' + (i + 1));
      btn.addEventListener('click', function(){ select(i); });
      bar.appendChild(btn);
    });
    tabs.insertBefore(bar, tabs.firstChild);
    var initial = panels.findIndex ? panels.findIndex(function(p){ return p.hasAttribute('data-active'); }) : -1;
    select(initial > 0 ? initial : 0);
  });
  root.querySelectorAll('table.cast-table thead th').forEach(function(th){
    th.addEventListener('click', function(){
      var table = th.closest('table');
      var body = table && table.tBodies[0];
      if (!body) return;
      var col = Array.prototype.indexOf.call(th.parentNode.children, th);
      var dir = th.getAttribute('data-sort') === 'asc' ? 'desc' : 'asc';
      table.querySelectorAll('th').forEach(function(h){ h.removeAttribute('data-sort'); });
      th.setAttribute('data-sort', dir);
      function cell(r){ var c = r.cells[col]; return c && c.textContent ? c.textContent.trim() : ''; }
      function num(s){ return parseFloat(s.replace(/[$,%\\s]/g, '')); }
      var rows = Array.prototype.slice.call(body.rows);
      var numeric = rows.every(function(r){ var v = cell(r); return !v || !isNaN(num(v)); });
      rows.sort(function(a, b){
        var av = cell(a), bv = cell(b);
        var cmp = numeric ? num(av) - num(bv) : av.localeCompare(bv);
        return dir === 'asc' ? cmp : -cmp;
      });
      rows.forEach(function(r){ body.appendChild(r); });
    });
  });
})();
</script></body></html>`;
  const policy = `default-src 'none'; script-src 'nonce-NONCE'; style-src 'unsafe-inline'; img-src data: ${convexOrigin}; media-src data: ${convexOrigin}; font-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; connect-src 'none'`;
  const shellLiteral = JSON.stringify(documentShell).replace(/</g, '\\u003C');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>
  const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('');
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = ${JSON.stringify(policy)}.replace('NONCE', nonce);
  document.head.append(policy);
  const parsed = new DOMParser().parseFromString(${shellLiteral}, 'text/html');
  for (const node of [...parsed.head.children, ...parsed.body.children]) {
    if (node.tagName === 'SCRIPT') {
      const script = document.createElement('script'); script.nonce = nonce; script.textContent = node.textContent; document.body.append(script);
    } else document.body.append(document.adoptNode(node));
  }
  </script></body></html>`;
}

