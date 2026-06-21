import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logTrace } from "../../logging";
import { BrowserMessageEvent } from "skyrimPlatform";
import { MsgType } from "../../messages";

declare const window: any;

const CHAT_MSG_PROP = 'ff_chatMsg';

const buildMountJs = (name: string, isAdmin: boolean) => `(function(){
  try {
    if (window.__skyrpChatReady) return;
    if (!window.skyrimPlatform || !window.skyrimPlatform.widgets) return;
    window.__skyrpChatReady = true;
    window.__skyrpName = ${JSON.stringify(name)};
    window.__skyrpAdmin = ${isAdmin ? 'true' : 'false'};
    if (!window.chatMessages) window.chatMessages = [];

    // Force the chat to the upper-left corner.
    if (!document.getElementById('skyrpChatCss')) {
      var st = document.createElement('style');
      st.id = 'skyrpChatCss';
      st.innerHTML = '#chat{top:24px!important;left:24px!important;right:auto!important;bottom:auto!important;}';
      document.head.appendChild(st);
    }

    var WHITE = '#fafafa';
    // Color per message kind.
    var COLORS = { say:WHITE, me:'#c37bdd', my:'#c37bdd', do:'#c37bdd', looc:'#1f7a33',
                   yell:'#ce3131', whisper:'#9a9a9a', ooc:WHITE, system:'#ff8c00',
                   admin:'#ce3131', pm:'#4ec9b0' };
    // Tab each kind shows in. 'all' = every tab.
    var TAB = { say:'local', me:'local', my:'local', do:'local', looc:'local',
                yell:'local', whisper:'local', ooc:'global', system:'all',
                admin:'admin', pm:'personal' };
    // Spoken lines that float over the head as a bubble.
    var BUBBLE = { say:1, me:1, my:1, looc:1 };
    var ALIAS = { shout:'yell', y:'yell', b:'looc', w:'whisper', dm:'pm', to:'pm', too:'pm' };

    // Keep "quoted" text white inside an otherwise-colored line (/me, /my).
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

    // Parse a typed line. No slash = /say.
    function parse(raw){
      var text=String(raw).trim(); if(!text) return null;
      var kind='say', body=text;
      if (text.charAt(0)==='/'){
        var i=text.indexOf(' ');
        var cmd=(i<0?text:text.slice(0,i)).slice(1).toLowerCase();
        body=(i<0?'':text.slice(i+1)).trim();
        kind=ALIAS[cmd]||cmd;
        if (!COLORS[kind]){ return { command:true }; }
      }
      if ((kind==='system' || kind==='admin') && !window.__skyrpAdmin) return { denied:true };
      if (!body && kind!=='do' && kind!=='pm') return null;

      var n=window.__skyrpName||'You', c=COLORS[kind], segs, plain=body;
      if (kind==='say'){ segs=[{text:n+' says. "'+body+'"',color:c}]; }
      else if (kind==='me'){ segs=[{text:n+' ',color:c}].concat(quoteSegs(body,c)); plain=n+' '+body; }
      else if (kind==='my'){ segs=[{text:n+"'s ",color:c}].concat(quoteSegs(body,c)); plain=n+"'s "+body; }
      else if (kind==='do'){ segs=quoteSegs(body,c); }
      else if (kind==='looc'){ segs=[{text:n+': '+body,color:c}]; plain=n+': '+body; }
      else if (kind==='yell'){ plain=(n+' shouts '+body).toUpperCase(); segs=[{text:plain,color:c}]; }
      else if (kind==='whisper'){ segs=[{text:n+' whispers, "'+body+'"',color:c}]; }
      else if (kind==='ooc'){ segs=[{text:n+': '+body,color:c}]; }
      else if (kind==='system'){ segs=[{text:body,color:c}]; }
      else if (kind==='admin'){ segs=[{text:n+': '+body,color:c}]; }
      else if (kind==='pm'){
        var i2=body.indexOf(' ');
        var target=i2<0?body:body.slice(0,i2);
        var pmText=i2<0?'':body.slice(i2+1).trim();
        if (!target || !pmText) return { error:'Usage: /pm <player|account|id> <message>' };
        segs=[{text:'To '+target+': '+pmText,color:c}];
        plain=pmText;
      }
      return { kind:kind, segs:segs, tab:TAB[kind], bubble:!!BUBBLE[kind], plain:plain };
    }

    function pushSegs(segs, tab){
      var t=segs.map(function(s){ return {text:s.text,color:s.color,opacity:1,type:['default']}; });
      window.chatMessages.push({text:t, category:'plain', opacity:1, channel:tab});
      if (window.chatMessages.length>100) window.chatMessages.shift();
      var w=window.skyrimPlatform.widgets.get()||[];
      window.skyrimPlatform.widgets.set(w.map(function(x){
        return x.type!=='chat' ? x : Object.assign({}, x, {messages:window.chatMessages.slice()});
      }));
      if (typeof window.scrollToLastMessage==='function') window.scrollToLastMessage();
    }

    // Chat bubble
    var sf=function(raw){
      var p=parse(raw); if(!p) return;
	  if (p.command){ if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) window.skyrimPlatform.sendMessage('cef::chat:send', raw); return; }
      if (p.denied){ pushSegs([{text:'Only admins can use that command.',color:COLORS.system}],'all'); return; }
      if (p.error){ pushSegs([{text:p.error,color:COLORS.system}],'personal'); return; }
      pushSegs(p.segs, p.tab);
      if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) window.skyrimPlatform.sendMessage('cef::chat:send', raw);
    };

    var chatWidget={ type:'chat', id:'chat', isInputHidden:false, placeholder:'', messages:window.chatMessages.slice(), send:sf };
    window.__skyrpChatWidget=chatWidget;
    var cur=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){ return w.type!=='chat'; });
    window.skyrimPlatform.widgets.set([chatWidget].concat(cur)); // always own chat

    // Incoming text from the server / other players.
    window.__skyrpAddChat=function(raw){
      var s=String(raw);
      // Strip the server's "<nonce>" prefix (makes repeats unique so they render).
      var us=s.indexOf('\\u001f');
      if (us>0 && /^[0-9]+$/.test(s.slice(0,us))) s=s.slice(us+1);
      var bubbleRefr=0;
	  if (s.indexOf('[[B')===0){ var be=s.indexOf(']]'); var hex=be>3?s.slice(3,be):''; if (hex && /^[0-9a-fA-F]+$/.test(hex)){ bubbleRefr=parseInt(hex,16); s=s.slice(be+2); } }
      // Private message: "[[PM]]<sender>|<text>" -> Personal tab.
      if (s.indexOf('[[PM]]')===0){
        var rest=s.slice(6), bar=rest.indexOf('|');
        var sender=bar<0?'PM':rest.slice(0,bar), pmTxt=bar<0?rest:rest.slice(bar+1);
        pushSegs([{text:sender+': '+pmTxt,color:COLORS.pm}],'personal');
        return;
      }
      // Channel tag -> tab. Untagged lines are local (say/me/my/do/looc/yell/whisper).
      var tab='local';
      if (s.indexOf('[[G]]')===0){ tab='global'; s=s.slice(5); }
      else if (s.indexOf('[[S]]')===0){ tab='all'; s=s.slice(5); }
      else if (s.indexOf('[[A]]')===0){ tab='admin'; s=s.slice(5); }
      // Parse a '#{rrggbb}text' colored line.
      var parts=s.split('#{'), segs=[], col=WHITE;
      for (var i=0;i<parts.length;i++){ var p=parts[i];
        if (i===0){ if(p) segs.push({text:p,color:col}); continue; }
        var ci=p.indexOf('}');
        if (ci===6){ col='#'+p.slice(0,6); var txt=p.slice(7); if(txt) segs.push({text:txt,color:col}); }
        else segs.push({text:'#{'+p,color:col});
      }
      if (segs.length){
        pushSegs(segs,tab);
        if (bubbleRefr && window.skyrimPlatform && window.skyrimPlatform.sendMessage){
          window.skyrimPlatform.sendMessage('skyrpChatBubble', bubbleRefr, segs.map(function(x){ return x.text; }).join(''));
        }
      }
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
    if (e.arguments[0] === "cef::chat:send") {
      const text = String(e.arguments[1] ?? "");
      if (!text) return;
      this.controller.emitter.emit("sendMessage", {
        message: { t: MsgType.CustomPacket, contentJsonDump: JSON.stringify({ type: "cef::chat:send", data: text }) },
        reliability: "reliable",
      });
    }
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
      this.sp.browser.executeJavaScript(buildMountJs(name, isAdmin));
      this.sp.browser.setVisible(true);
    }

    const liveName = appearance?.name;
    if (liveName && liveName !== this.lastName) {
      this.lastName = liveName;
      this.sp.browser.executeJavaScript(`window.__skyrpName=${JSON.stringify(liveName)};`);
    }

    const msg = owner[CHAT_MSG_PROP];
    if (typeof msg === "string" && msg !== "" && msg !== this.lastMsg) {
      this.lastMsg = msg;
      this.sp.browser.executeJavaScript(`window.__skyrpAddChat && window.__skyrpAddChat(${JSON.stringify(msg)});`);
    }
  }

  // Chat bubbles over the player's head for spoken lines (/say /me /my /looc).
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
}
