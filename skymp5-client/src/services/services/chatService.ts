import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";
import { BrowserMessageEvent } from "skyrimPlatform";
import { MsgType } from "../../messages";

declare const window: any;

const CHAT_MSG_PROP = 'ff_chatMsg';

// Skyrim world units per meter ~69.99.
const UNITS_PER_METER = 70;

const buildMountJs = (name: string, isAdmin: boolean, settingsJson: string) => `(function(){
  try {
    if (window.__skyrpChatReady) return;
    if (!window.skyrimPlatform || !window.skyrimPlatform.widgets) return;
    window.__skyrpChatReady = true;
    window.__skyrpAdmin = ${isAdmin ? 'true' : 'false'};
    if (!window.chatMessages) window.chatMessages = [];

    // Restore saved settings before the widget mounts so the UI seeds from them.
    window.__skyrpChatSettings = ${settingsJson};
    if (window.__skyrpChatSettings && window.__skyrpChatSettings.customHighlights != null) window.__skyrpCustomHighlightsRaw = window.__skyrpChatSettings.customHighlights;

    // Force the chat to the upper-left corner.
    if (!document.getElementById('skyrpChatCss')) {
      var st = document.createElement('style');
      st.id = 'skyrpChatCss';
      st.innerHTML = '#chat{top:24px!important;left:24px!important;right:auto!important;bottom:auto!important;}';
      document.head.appendChild(st);
    }

    var WHITE='#fafafa';
    var ME='#c2a3da';
    var OOC='#3896f3';
    var SHOUT='#772021';
    var SYS='#eda841';
    var PM='#4ec9b0';
    var NAME='#fbf724';

    var DARKEN_RANGE_M=80;
    // Audible range per channel is enforced server-side, so it is not stored here.
    var CH = {
      say:     {color:WHITE,  tab:'local',    fmt:'say'},
      low:     {color:WHITE,  tab:'local',    fmt:'sayquiet'},
      whisper: {color:WHITE,  tab:'local',    fmt:'whisper'},
      wide:    {color:WHITE,  tab:'local',    fmt:'sayloud'},
      shout:   {color:SHOUT,  tab:'local',    fmt:'shout'},
      me:      {color:ME,     tab:'local',    fmt:'me'},
      melow:   {color:ME,     tab:'local',    fmt:'me'},
      melong:  {color:ME,     tab:'local',    fmt:'me'},
      my:      {color:ME,     tab:'local',    fmt:'my'},
      mylow:   {color:ME,     tab:'local',    fmt:'my'},
      mylong:  {color:ME,     tab:'local',    fmt:'my'},
      do:      {color:ME,     tab:'local',    fmt:'do'},
      dolow:   {color:ME,     tab:'local',    fmt:'do'},
      dolong:  {color:ME,     tab:'local',    fmt:'do'},
      ooc:     {color:OOC,    tab:'local',    fmt:'ooc', oocLabel:'OOC'},
      ooclow:  {color:OOC,    tab:'local',    fmt:'ooc', oocLabel:'OOC - Low'},
      ooclong: {color:OOC,    tab:'local',    fmt:'ooc', oocLabel:'OOC - Long'},
      system:  {color:SYS,    tab:'all',      fmt:'plain', admin:1},
      flavor:  {color:SYS,    tab:'system',   fmt:'plain'},
      pm:      {color:PM,     tab:'personal', fmt:'pm'}
    };

    var ALIAS = {
      l:'low',
      w:'whisper',
      long:'wide',
      s:'shout', y:'shout', yell:'shout',
      mel:'melow', mew:'melong', mewide:'melong',
      myl:'mylow', myw:'mylong', mywide:'mylong',
      dol:'dolow', dow:'dolong', dowide:'dolong',
      b:'ooc', looc:'ooc',
      bl:'ooclow', loocl:'ooclow', oocl:'ooclow', blow:'ooclow', looclow:'ooclow',
      bw:'ooclong', loocw:'ooclong', oocw:'ooclong', bwide:'ooclong', loocwide:'ooclong', blong:'ooclong', looclong:'ooclong',
      dm:'pm', to:'pm', too:'pm'
    };

    if (!window.__skyrpNames) window.__skyrpNames = [];
    window.__skyrpSetNames=function(full){
      window.__skyrpName=String(full==null?'':full);
      var parts=window.__skyrpName.trim().split(' ').filter(function(x){ return x.length; });
      var arr=[];
      if (window.__skyrpName.trim()) arr.push(window.__skyrpName.trim());
      if (parts.length>1){ arr.push(parts[0]); arr.push(parts[parts.length-1]); }
      var seen={}, out=[];
      for (var i=0;i<arr.length;i++){ var k=arr[i].toLowerCase(); if(!seen[k]){ seen[k]=1; out.push(arr[i]); } }
      window.__skyrpNames=out;
    };
    window.__skyrpSetNames(${JSON.stringify(name)});

    function escapeRe(s){
      var sp='.*+?^()|[]{}$';
      var o='';
      for (var i=0;i<s.length;i++){ var c=s.charAt(i); o+=(sp.indexOf(c)>=0?'\\\\':'')+c; }
      return o;
    }
    // Build highlight matchers: names (whole-word, case-insensitive) + custom words.
    function buildTerms(){
      var terms=[];
      var names=(window.__skyrpNames||[]).filter(function(n){ return n && n.length>1; });
      for (var i=0;i<names.length;i++) terms.push(new RegExp('\\\\b'+escapeRe(names[i])+'\\\\b','gi'));
      // custom words: * wildcard, "quotes" = case-sensitive, comma/colon/newline separators.
      var raw=String(window.__skyrpCustomHighlightsRaw||''), NL=String.fromCharCode(10);
      var toks=raw.split(',').join(NL).split(':').join(NL).split(String.fromCharCode(13)).join(NL).split(NL);
      for (var j=0;j<toks.length;j++){
        var t=toks[j].trim(); if(!t) continue;
        var ci=true;
        if (t.length>=2 && t.charAt(0)==='"' && t.charAt(t.length-1)==='"'){ ci=false; t=t.slice(1,-1).trim(); }
        if (!t || t.split('*').join('')===''){ continue; }
        var parts=t.split('*');
        for (var p=0;p<parts.length;p++) parts[p]=escapeRe(parts[p]);
        try { terms.push(new RegExp(parts.join('[^ ]*'), ci?'gi':'g')); } catch(e){}
      }
      return terms;
    }
    // Re-colour name / custom-word matches to NAME. nohl segments are skipped.
    function highlightNames(segs){
      var terms=buildTerms();
      if (!terms.length) return segs;
      var out=[];
      for (var s=0;s<segs.length;s++){
        var seg=segs[s];
        if (seg.nohl || seg.color===NAME){ out.push(seg); continue; }
        var text=seg.text, pos=0;
        while (pos<text.length){
          var best=-1, bestEnd=-1;
          for (var k=0;k<terms.length;k++){
            terms[k].lastIndex=pos;
            var m=terms[k].exec(text);
            if (m && (best===-1 || m.index<best)){ best=m.index; bestEnd=m.index+m[0].length; }
          }
          if (best===-1){ out.push({text:text.slice(pos),color:seg.color}); break; }
          if (best>pos) out.push({text:text.slice(pos,best),color:seg.color});
          if (bestEnd>best){ out.push({text:text.slice(best,bestEnd),color:NAME}); pos=bestEnd; }
          else pos=best+1;
        }
      }
      return out;
    }

    function darken(hex, t){
      t=t<0?0:(t>1?1:t);
      var f=1-t*0.6;
      var h=hex.charAt(0)==='#'?hex.slice(1):hex;
      if (h.length===3) h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
      var r=parseInt(h.slice(0,2),16), g=parseInt(h.slice(2,4),16), b=parseInt(h.slice(4,6),16);
      if (isNaN(r)||isNaN(g)||isNaN(b)) return hex;
      function hx(v){ v=Math.round(v); v=v<0?0:(v>255?255:v); var x=v.toString(16); return x.length<2?'0'+x:x; }
      return '#'+hx(r*f)+hx(g*f)+hx(b*f);
    }
    function darkenSegs(segs, t){
      if (!(t>0)) return segs;
      return segs.map(function(seg){
        return { text:seg.text, color: seg.color===NAME ? seg.color : darken(seg.color,t) };
      });
    }

    // Allows "quoted text" to appear as /say
    function quoteSegs(text, base){
      var segs=[], re=/"([^"]*)"/g, last=0, m;
      while ((m=re.exec(text))){
        if (m.index>last) segs.push({text:text.slice(last,m.index),color:base});
        segs.push({text:'"'+m[1]+'"',color:WHITE});
        last=re.lastIndex;
      }
      if (last<text.length) segs.push({text:text.slice(last),color:base});
      return segs;
    }

    var VERB={say:'says',sayquiet:'says quietly',whisper:'whispers',sayloud:'says loudly',shout:'shouts'};
    // Leading name is its own nohl segment so highlighting skips your own name.
    function fmtLine(kind, n, body){
      var ch=CH[kind], c=ch.color, f=ch.fmt;
      var nm={text:n,color:c,nohl:1};
      if (VERB[f]) return [nm,{text:' '+VERB[f]+': "'+body+'"',color:c}];
      if (f==='me')      return [nm,{text:' ',color:c}].concat(quoteSegs(body,c));
      if (f==='my')      return [nm,{text:"'s ",color:c}].concat(quoteSegs(body,c));
      if (f==='do')      return quoteSegs(body,c);
      if (f==='ooc')     return [nm,{text:' ('+ch.oocLabel+'): "'+body+'"',color:c}];
      return [{text:body,color:c}]; // plain: system / flavour
    }

    // Alias fixes
    function forwardFor(kind, body){
      var f=CH[kind].fmt;
      if (f==='me')   return '/me '+body;
      if (f==='my')   return '/my '+body;
      if (f==='do')   return '/do '+body;
      if (f==='ooc')  return '/looc '+body;
      if (f==='shout')return '/shout '+body;
      if (kind==='system') return '/system '+body;
      // say family (say/low/whisper/wide) - unprefixed text is in-character say.
      return body;
    }

    // Parse a typed line. No slash = /say.
    function parse(raw){
      var text=String(raw).trim(); if(!text) return null;
      var kind='say', body=text;
      if (text.charAt(0)==='/'){
        var i=text.indexOf(' ');
        var cmd=(i<0?text:text.slice(0,i)).slice(1).toLowerCase();
        body=(i<0?'':text.slice(i+1)).trim();
        kind=ALIAS[cmd]||cmd;
        if (!CH[kind]){ return { command:true }; }
      }
      var ch=CH[kind];
      // Cosmetic gate only; the server is authoritative on admin-only commands.
      if (ch.admin && !window.__skyrpAdmin) return { denied:true };
      if (kind==='pm'){
        var i2=body.indexOf(' ');
        var target=i2<0?body:body.slice(0,i2);
        var pmText=i2<0?'':body.slice(i2+1).trim();
        if (!target || !pmText) return { error:'Usage: /pm <player|account|id> <message>' };
        return { kind:kind, segs:[{text:'To '+target+': '+pmText,color:PM}], tab:'personal', fwd:raw };
      }
      if (!body) return null;
      var n=window.__skyrpName||'You';
      return { kind:kind, segs:fmtLine(kind,n,body), tab:ch.tab, fwd:forwardFor(kind,body) };
    }

    // Merge neighbouring runs of the same colour (tidies up the name/quote splits).
    function mergeSegs(segs){
      var out=[];
      for (var i=0;i<segs.length;i++){
        var s=segs[i];
        if (out.length && out[out.length-1].color===s.color) out[out.length-1].text+=s.text;
        else out.push({text:s.text,color:s.color});
      }
      return out;
    }
    function pushSegs(segs, tab){
      var t=mergeSegs(highlightNames(segs)).map(function(s){ return {text:s.text,color:s.color,opacity:1,type:['default']}; });
      window.chatMessages.push({text:t, category:'plain', opacity:1, channel:tab});
      if (window.chatMessages.length>100) window.chatMessages.shift();
      var w=window.skyrimPlatform.widgets.get()||[];
      window.skyrimPlatform.widgets.set(w.map(function(x){
        return x.type!=='chat' ? x : Object.assign({}, x, {messages:window.chatMessages.slice()});
      }));
      if (typeof window.scrollToLastMessage==='function') window.scrollToLastMessage();
    }

    // Local echo + send to server.
    var sf=function(raw){
      var p=parse(raw); if(!p) return;
	  if (p.command){ if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) window.skyrimPlatform.sendMessage('cef::chat:send', raw); return; }
      if (p.denied){ pushSegs([{text:'Only admins can use that command.',color:SYS}],'all'); return; }
      if (p.error){ pushSegs([{text:p.error,color:SYS}],'personal'); return; }
      pushSegs(p.segs, p.tab);
      var fwd=(p.fwd!=null)?p.fwd:raw;
      if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) window.skyrimPlatform.sendMessage('cef::chat:send', fwd);
    };

    var chatWidget={ type:'chat', id:'chat', isInputHidden:false, placeholder:'', messages:window.chatMessages.slice(), send:sf };
    var cur=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){ return w.type!=='chat'; });
    window.skyrimPlatform.widgets.set([chatWidget].concat(cur)); // always own chat

    // Incoming text from the server / other players and distance dimming
    window.__skyrpAddChat=function(raw, dist){
      var s=String(raw);
      // Strip the server's "<nonce>" prefix (makes repeats unique so they render).
      var us=s.indexOf('\\u001f');
      if (us>0 && /^[0-9]+$/.test(s.slice(0,us))) s=s.slice(us+1);
      var bubbleRefr=0;
	  if (s.indexOf('[[B')===0){ var be=s.indexOf(']]'); var hex=be>3?s.slice(3,be):''; if (hex && /^[0-9a-fA-F]+$/.test(hex)){ bubbleRefr=parseInt(hex,16); s=s.slice(be+2); } }
      // Private messages
      if (s.indexOf('[[PM]]')===0){
        var rest=s.slice(6), bar=rest.indexOf('|');
        var sender=bar<0?'PM':rest.slice(0,bar), pmTxt=bar<0?rest:rest.slice(bar+1);
        // Fix for some system messages not going into system
        var lo=String(sender).toLowerCase();
        if (lo==='system' || lo==='server'){
          pushSegs([{text:pmTxt,color:SYS}],'system');
          return;
        }
        pushSegs([{text:sender+': '+pmTxt,color:PM}],'personal');
        return;
      }
      // Channel tag -> tab. Untagged lines are local (spoken / emote / ooc).
      var tab='local';
      if (s.indexOf('[[G]]')===0){ tab='local'; s=s.slice(5); }      // legacy global -> local
      else if (s.indexOf('[[S]]')===0){ tab='all'; s=s.slice(5); }
      else if (s.indexOf('[[A]]')===0){ tab='admin'; s=s.slice(5); }
      // Parse a '#{rrggbb}text' coloured line.
      var parts=s.split('#{'), segs=[], col=WHITE;
      for (var i=0;i<parts.length;i++){ var p=parts[i];
        if (i===0){ if(p) segs.push({text:p,color:col}); continue; }
        var ci=p.indexOf('}');
        if (ci===6){ col='#'+p.slice(0,6); var txt=p.slice(7); if(txt) segs.push({text:txt,color:col}); }
        else segs.push({text:'#{'+p,color:col});
      }
      if (segs.length){
        var d=(typeof dist==='number')?dist:-1;
        if (d>0) segs=darkenSegs(segs, d/DARKEN_RANGE_M);
        pushSegs(segs,tab);
        if (bubbleRefr && window.skyrimPlatform && window.skyrimPlatform.sendMessage){
          window.skyrimPlatform.sendMessage('skyrpChatBubble', bubbleRefr, segs.map(function(x){ return x.text; }).join(''));
        }
      }
    };

    // Vanilla-style corner notifications system tab
    window.__skyrpAddSystem=function(text){
      var t=String(text==null?'':text); if(!t) return;
      pushSegs([{text:t,color:SYS}],'system');
    };

    // Lines triggered by spells, conditions, zones, etc
    window.__skyrpAddFlavor=function(text){
      var t=String(text==null?'':text); if(!t) return;
      pushSegs([{text:t,color:SYS}], CH.flavor.tab);
    };
  } catch (e) {}
})();`;

export class ChatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    if (e.arguments[0] === "skyrpChatBubble") {
      this.showBubble(Number(e.arguments[1] ?? 0), String(e.arguments[2] ?? ""));
      return;
    }
    if (e.arguments[0] === "cef::chat:saveSettings") {
      this.writeChatSettings(String(e.arguments[1] ?? ""));
      return;
    }
    if (e.arguments[0] === "cef::chat:send") {
      const text = String(e.arguments[1] ?? "");
      if (!text) return;
      this.controller.emitter.emit("sendMessage", {
        message: { t: MsgType.CustomPacket, contentJsonDump: JSON.stringify({ type: "cef::chat:send", data: text }) },
        reliability: "reliable",
      });
    }
  }

  // Read saved settings, returning a validated JSON object literal string or "{}".
  private readChatSettings(): string {
    try {
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(this.pluginChatSettingsName, "PluginsNoLoad");
      if (!data) return "{}";
      const parsed = JSON.parse(data.slice(2));
      if (!parsed || typeof parsed !== "object") return "{}";
      return JSON.stringify(parsed);
    } catch (e) {
      return "{}";
    }
  }

  // Persist settings sent from the chat UI to disk so they survive a relaunch.
  private writeChatSettings(json: string): void {
    if (!json) return;
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") return;
      this.sp.writePlugin(
        this.pluginChatSettingsName,
        "//" + JSON.stringify(parsed),
        // @ts-expect-error (TODO: Remove in 2.10.0)
        "PluginsNoLoad"
      );
    } catch (e) {}
  }

  private onUpdate(): void {
    this.expireBubbles();

    if (this.sp.storage["ownerModelSet"] !== true) return;
    const owner = this.sp.storage["ownerModel"] as Record<string, unknown> | undefined;
    if (!owner) return;

    const appearance = owner["appearance"] as { name?: string } | undefined;

    if (!this.mounted) {
      this.mounted = true;
      const name = appearance?.name || "You";
      const isAdmin = owner["isAdmin"] === true;
      logTrace(this, "Mounting chat widget (local parse + render)");
      this.sp.browser.executeJavaScript(buildMountJs(name, isAdmin, this.readChatSettings()));
      this.sp.browser.setVisible(true);
    }

    const liveName = appearance?.name;
    if (liveName && liveName !== this.lastName) {
      this.lastName = liveName;
      this.sp.browser.executeJavaScript(`window.__skyrpSetNames && window.__skyrpSetNames(${JSON.stringify(liveName)});`);
    }

    const msg = owner[CHAT_MSG_PROP];
    if (typeof msg === "string" && msg !== "" && msg !== this.lastMsg) {
      this.lastMsg = msg;
      const dist = this.senderDistanceMeters(msg);
      this.sp.browser.executeJavaScript(`window.__skyrpAddChat && window.__skyrpAddChat(${JSON.stringify(msg)}, ${dist});`);
    }
  }

  private senderDistanceMeters(raw: string): number {
    try {
      let s = raw;
      const us = s.indexOf("\u001f");
      if (us > 0 && /^[0-9]+$/.test(s.slice(0, us))) s = s.slice(us + 1);
      if (s.indexOf("[[B") !== 0) return -1;
      const be = s.indexOf("]]");
      const hex = be > 3 ? s.slice(3, be) : "";
      if (!/^[0-9a-fA-F]+$/.test(hex)) return -1;
      const refId = parseInt(hex, 16);
      if (!refId) return -1;
      const sender = this.sp.ObjectReference.from(this.sp.Game.getFormEx(refId));
      const player = this.sp.Game.getPlayer();
      if (!sender || !player) return -1;
      const dx = sender.getPositionX() - player.getPositionX();
      const dy = sender.getPositionY() - player.getPositionY();
      const dz = sender.getPositionZ() - player.getPositionZ();
      const meters = Math.sqrt(dx * dx + dy * dy + dz * dz) / UNITS_PER_METER;
      return Math.round(meters * 100) / 100;
    } catch (e) {
      return -1;
    }
  }

  // Chat bubbles over the player's head for IC lines (/say /me /my ...).
  private showBubble(refrId: number, text: string): void {
    if (!text || !refrId) return;
    const id = this.sp.createText(-1000, -1000, text.slice(0, 100), [1, 1, 1, 1]);
    this.sp.setTextSize(id, 0.4);
    this.sp.setTextRefr(id, refrId);
    this.sp.setTextRefrNode(id, "NPC Head [Head]");
    this.sp.setTextRefrOffset(id, [0, 0, 40]);
    this.bubbles.push({ id, expiresAt: Date.now() + 6000 });
  }

  private expireBubbles(): void {
    const now = Date.now();
    this.bubbles = this.bubbles.filter((b) => {
      if (now < b.expiresAt) return true;
      this.sp.destroyText(b.id);
      return false;
    });
  }

  private mounted = false;
  private lastMsg: string | null = null;
  private lastName: string | null = null;
  private bubbles: { id: number; expiresAt: number }[] = [];
  private readonly pluginChatSettingsName = "chat-settings-no-load";
}
