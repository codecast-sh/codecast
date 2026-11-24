// The page's views, for the in-page bar (artifactPages.ts interpolates both
// strings into its CSS and script, so the script's own names are in scope:
// saved, parseAnchor, el).
//
// A page with several views (steps, tabs, screens of a flow) keeps the one
// showing in ?view=<name>, written with history.replaceState/pushState. A
// comment records the view it was made on (anchor.view) and shows only
// there; no param, or an anchor without one, is the landing view "". A reply
// belongs to its thread's view.

export const PAGE_VIEWS_CSS = `
  /* Comments made on the page's other views: one row per view, linking there. */
  #__cc_cpanel .__cc_ovs { margin: 14px -10px -10px; padding: 4px 4px 6px; border-top: 1px solid var(--cc-line); }
  #__cc_cpanel .__cc_ovh { color: var(--cc-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; padding: 6px 10px 2px; }
  #__cc_cpanel .__cc_ov { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; color: var(--cc-ink); text-decoration: none; font-size: 12px; }
  #__cc_cpanel .__cc_ov:hover { background: var(--cc-hov); }
  #__cc_cpanel .__cc_ovv { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #__cc_cpanel .__cc_ovn { margin-left: auto; color: var(--cc-dim); flex-shrink: 0; }`;

export const PAGE_VIEWS_JS = `
  var viewNow=function(){try{return (new URLSearchParams(location.search).get("view")||"").slice(0,200);}catch(e){return "";}};
  var curView=viewNow();
  var viewOf=function(c){var an=parseAnchor(c);return an&&typeof an.view==="string"?an.view:"";};
  var threadViews=function(){var m={};saved.forEach(function(c){if(!c.parent_id)m[c.id]=viewOf(c);});return m;};
  var viewOfIn=function(c,tv){return c.parent_id&&tv[c.parent_id]!==undefined?tv[c.parent_id]:viewOf(c);};
  var savedHere=function(){var tv=threadViews();return saved.filter(function(c){return viewOfIn(c,tv)===curView;});};
  // The same page at another view, every other param (gate tokens, live,
  // theme) kept. c is dropped unless asked for: it would reopen a thread.
  var viewUrl=function(v,keepC){var q=new URLSearchParams(location.search);
    if(v)q.set("view",v);else q.delete("view");if(!keepC)q.delete("c");
    var s=q.toString();return location.pathname+(s?"?"+s:"")+location.hash;};
  // The page changing view under the bar: wrap the history writes it makes
  // and listen for back/forward; onChange runs once curView has moved, in a
  // later task, so pins are measured on the view the page has drawn (the
  // page draws right after its history write, and the bar's popstate
  // listener runs before the page's own). Not a frame: a background tab
  // runs none.
  var watchViews=function(onChange){
    var check=function(){var v=viewNow();if(v===curView)return;curView=v;setTimeout(onChange,0);};
    ["pushState","replaceState"].forEach(function(k){
      var orig=history[k];if(typeof orig!=="function")return;
      history[k]=function(){var r=orig.apply(this,arguments);try{check();}catch(e){}return r;};
    });
    window.addEventListener("popstate",check);
  };
  // A ?c= deep link to a comment made on another view: reopen the page on
  // that view and say so (the caller stops). Once only: if the URL this
  // document was requested at already named it, the page moved off it on its
  // own, and reloading again would loop.
  var leaveForView=function(target){
    var tview=target?viewOfIn(target,threadViews()):curView;
    if(tview===curView)return false;
    // No navigation entry to read: fail safe, never reload.
    var asked=tview;try{var nav=performance.getEntriesByType("navigation")[0];if(nav)asked=(new URL(nav.name).searchParams.get("view")||"").slice(0,200);}catch(e){}
    if(asked===tview)return false;
    location.replace(viewUrl(tview,true));return true;
  };
  // The other views' comments, counted per view (replies with their thread).
  var viewsElsewhere=function(){var tv=threadViews(),by={},n=0;
    saved.forEach(function(c){var v=viewOfIn(c,tv);if(v!==curView){by[v]=(by[v]||0)+1;n++;}});
    return {by:by,n:n};};
  var otherViewsEl=function(by){
    var ovs=el("div","__cc_ovs");
    ovs.appendChild(el("div","__cc_ovh","Other views"));
    Object.keys(by).sort().forEach(function(v){
      var a=document.createElement("a");a.className="__cc_ov";a.href=viewUrl(v,false);
      a.title="Open the page on this view";
      a.appendChild(el("span","__cc_ovv",v||"Start"));
      a.appendChild(el("span","__cc_ovn",by[v]+(by[v]===1?" comment":" comments")));
      ovs.appendChild(a);
    });
    return ovs;
  };`;
