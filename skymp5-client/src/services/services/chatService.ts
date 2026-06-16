import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { logTrace } from "../../logging";

// for the browser-side bootstrap (executed inside the CEF browser)
declare const window: any;

/**
 * Brings up the in-game chat widget on the client and bridges it to the server.
 *
 * In skymp the chat widget is normally created by the gamemode's browser
 * property system; a minimal gamemode.js can't easily do that, so the client
 * creates it here and talks to the server with simple custom packets. The
 * gamemode only has to receive a message and broadcast it back to the people
 * who should see it.
 *
 * Protocol — both are {@link MsgType.CustomPacket} with a JSON dump:
 *
 *   Client -> Server, the player sent chat (raw text, may carry a channel
 *   prefix such as "/looc ..." from the chat channel selector):
 *     { "customPacketType": "chatMessage", "text": "/looc hello" }
 *
 *   Server -> Client, a message to display (broadcast to the right people):
 *     { "customPacketType": "chatMessage",
 *       "name": "Lydia",          // optional sender prefix
 *       "text": "hello there",
 *       "color": "#ffffff",       // optional body colour
 *       "category": "rp" }        // "plain" => hidden by the non-rp filter
 *
 * The widget itself (top-left, draggable, resizable) lives in skymp5-front;
 * this service only instantiates it and pumps messages in/out.
 */
export class ChatService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
  }

  private onCreateActorMessage(event: ConnectionMessage<CreateActorMessage>): void {
    // Our own actor spawned. Bring up the chat a moment later so it runs after
    // AuthService clears the login widgets on this same event.
    if (event.message.isMe) {
      this.sp.Utility.wait(0.1).then(() => this.ensureChat());
    }
  }

  private ensureChat(): void {
    if (this.chatSetup) {
      return;
    }
    this.chatSetup = true;
    logTrace(this, `Bootstrapping chat widget`);
    this.sp.browser.executeJavaScript(new FunctionInfo(this.chatBootstrap).getText());
    this.sp.browser.setVisible(true);
  }

  private onBrowserMessage(e: { arguments: unknown[] }): void {
    if (e.arguments[0] !== "chat:send") {
      return;
    }
    const text = e.arguments[1];
    if (typeof text !== "string" || text.trim() === "") {
      return;
    }
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: "chatMessage", text }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] !== "chatMessage") {
      return;
    }
    // Make sure the widget exists (e.g. a message arrives before our spawn hook).
    this.ensureChat();
    const payload = JSON.stringify({
      name: typeof content["name"] === "string" ? content["name"] : "",
      text: typeof content["text"] === "string" ? content["text"] : "",
      color: typeof content["color"] === "string" ? content["color"] : "#ffffff",
      category: content["category"] === "plain" ? "plain" : "rp",
    });
    this.sp.browser.executeJavaScript(`window.__skyrpAddChat && window.__skyrpAddChat(${payload});`);
  }

  // Runs inside the CEF browser. Creates the chat widget and a global to append
  // messages. Keeps the chat at index 0 so its React key stays stable (the
  // input text isn't lost when other widgets/menus come and go).
  private chatBootstrap = () => {
    if (!window.skyrimPlatform || !window.skyrimPlatform.widgets || window.__skyrpChatReady) {
      return;
    }
    window.__skyrpChatReady = true;
    window.chatMessages = window.chatMessages || [];

    var chatWidget = {
      type: 'chat',
      id: 'chat',
      isInputHidden: false,
      placeholder: '',
      messages: window.chatMessages,
      send: function (text: string) { window.skyrimPlatform.sendMessage('chat:send', text); },
    };

    var render = function () {
      var others = (window.skyrimPlatform.widgets.get() || []).filter(function (w: any) { return w.id !== 'chat'; });
      // New array ref for messages so the Chat component re-renders + scrolls.
      chatWidget.messages = window.chatMessages.slice();
      window.skyrimPlatform.widgets.set([chatWidget].concat(others));
    };

    window.__skyrpAddChat = function (msg: any) {
      var spans = [];
      if (msg.name) {
        spans.push({ text: msg.name + ': ', color: '#cccccc', opacity: 1, type: ['sender'] });
      }
      spans.push({ text: msg.text || '', color: msg.color || '#ffffff', opacity: 1, type: msg.category === 'plain' ? ['nonrp'] : [] });
      window.chatMessages.push({ category: msg.category || 'rp', text: spans, opacity: 1 });
      if (window.chatMessages.length > 200) { window.chatMessages.shift(); }
      render();
      if (window.scrollToLastMessage) { window.scrollToLastMessage(); }
    };

    render();
  };

  private chatSetup = false;
}
