// The document the phone terminal's WebView loads: xterm, render-only. The
// relay connection, the keyboard and every byte the pane receives live on the
// React Native side; this page only paints the screens it is handed and says
// when it was tapped. xterm runs with stdin disabled and no scrollback, so a
// gesture inside the page can never type into the pane.
//
// Messages in (window.__cc(json)): {t:'frame', data, cols, rows}.
// Messages out (ReactNativeWebView.postMessage): {t:'ready'} | {t:'tap'} | {t:'error', message}.
//
// The pane's geometry always wins, as on web: the terminal is sized to the
// pane's columns and the font is chosen so those columns fill the width, with
// pinch zoom for a closer look.


/** Solarized dark, the terminal's own palette: a dark island in either app theme. */
export const TERMINAL_BG = '#002b36';
const THEME = {
  background: TERMINAL_BG,
  foreground: '#93a1a1',
  cursor: '#93a1a1',
  cursorAccent: TERMINAL_BG,
  selectionBackground: '#073642',
  black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
  blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
  brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
  brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
};

// Close every </script inside the inlined source so it cannot end the tag early.
const inline = (src: string) => src.replace(/<\/script/gi, '<\\/script');

export function buildTerminalHtml(fontFamily = 'Menlo, monospace'): string {
  // Required here, not at the top: the half-megabyte source module is
  // evaluated only once someone opens a terminal.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { XTERM_CSS, XTERM_JS } = require('../vendor/xtermSource') as typeof import('../vendor/xtermSource');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=0.25, maximum-scale=5, user-scalable=yes">
<style>${XTERM_CSS}
html,body{margin:0;padding:0;background:${TERMINAL_BG};-webkit-text-size-adjust:none}
body{overflow:auto;-webkit-overflow-scrolling:touch}
#t{padding:6px 4px 6px 4px;display:inline-block}
.xterm .xterm-helper-textarea{display:none}
.xterm-cursor-layer,.xterm .xterm-cursor{opacity:.85}
</style></head><body><div id="t"></div>
<script>${inline(XTERM_JS)}</script>
<script>
(function(){
  var post=function(m){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(m))};
  if(!window.Terminal){post({t:'error',message:'terminal renderer failed to load'});return}
  var FONT=${JSON.stringify(fontFamily)};
  var term=new window.Terminal({disableStdin:true,scrollback:0,cursorBlink:false,cursorStyle:'block',
    fontFamily:FONT,fontSize:10,lineHeight:1.1,allowProposedApi:false,
    theme:${JSON.stringify(THEME)}});
  term.open(document.getElementById('t'));
  var cols=80,rows=24,cursor=null,following=true,layoutW=0;
  // The font: the pane's columns across the width when that reads; otherwise
  // as large as the height allows, up to a comfortable size, and the pane
  // scrolls sideways (pinch out for the whole of it). A wide, short pane on a
  // tablet then fills the screen instead of a strip of tiny type. Sizes come
  // from the layout viewport, measured with the view at its full height:
  // a pinch or the keyboard never refits.
  var MIN_FONT=7,COMFY_FONT=11,MAX_FONT=15;
  function fit(){
    var de=document.documentElement;
    var w=de.clientWidth-8,h=de.clientHeight-12;
    layoutW=de.clientWidth;
    var probe=document.createElement('span');
    probe.style.cssText='position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:'+FONT;
    probe.textContent='MMMMMMMMMM';document.body.appendChild(probe);
    var box=probe.getBoundingClientRect();document.body.removeChild(probe);
    var byW=w/(cols*box.width/1000),byH=h/(rows*box.height/100*1.1);
    var size=Math.max(byW,Math.min(byH,COMFY_FONT));
    size=Math.max(MIN_FONT,Math.min(MAX_FONT,Math.floor(size*10)/10));
    if(term.options.fontSize!==size)term.options.fontSize=size;
  }
  // Keep the cursor, where a prompt waits for its answer, on screen: the
  // keyboard shrinks the view, and a wide pane puts it off to the side. Once
  // the person scrolls or pinches away it stays where they put it, until they
  // type again (window.__ccFollow).
  window.__ccFollow=function(){following=true;follow()};
  function follow(){
    if(!cursor||!following)return;
    var screen=document.querySelector('.xterm-screen');if(!screen)return;
    var r=screen.getBoundingClientRect();
    var cw=r.width/cols,ch=r.height/rows;
    var x=r.left+window.scrollX+cursor.x*cw,y=r.top+window.scrollY+cursor.y*ch;
    var vw=window.innerWidth,vh=window.innerHeight,sx=window.scrollX,sy=window.scrollY;
    if(y+ch*2>sy+vh)sy=y+ch*2-vh;else if(y-ch<sy)sy=Math.max(0,y-ch);
    if(x+cw*4>sx+vw)sx=x+cw*4-vw;else if(x-cw*4<sx)sx=Math.max(0,x-cw*4);
    if(sx!==window.scrollX||sy!==window.scrollY)window.scrollTo(sx,sy);
  }
  window.__cc=function(json){
    try{
      var m=JSON.parse(json);
      if(m.t==='frame'){
        if(m.cols&&m.rows&&(m.cols!==cols||m.rows!==rows)){cols=m.cols;rows=m.rows;term.resize(cols,rows);fit()}
        cursor=m.cursor||null;
        term.write(m.data,follow);
      }
    }catch(e){post({t:'error',message:String(e&&e.message||e)})}
  };
  window.addEventListener('resize',function(){
    if(Math.abs(document.documentElement.clientWidth-layoutW)>1)fit();
    follow();
  });
  document.addEventListener('touchmove',function(){following=false},{passive:true});
  // A tap (not a pinch or a pan) opens the keyboard.
  document.addEventListener('click',function(){post({t:'tap'})});
  fit();
  post({t:'ready'});
})();
</script></body></html>`;
}
