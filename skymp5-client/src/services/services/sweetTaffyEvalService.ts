import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { logError, logTrace } from "../../logging";
import { GamemodeApiCtx } from "../messages_gamemode/gamemodeApiCtx";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { NetworkingService } from "./networkingService";
import { RemoteServer } from "./remoteServer";
import { ServerJsVerificationService } from "./serverJsVerificationService";
import { once, printConsole } from "skyrimPlatform";
import * as sp from "skyrimPlatform";

export class SweetTaffyEvalService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();


        onCustomPacket(this.controller, "eval", (content) => this.onCustomPacketMessage(content));
    }

    private onCustomPacketMessage(msgContent: CustomPacketContent): void {
        switch (msgContent["customPacketType"]) {
            case 'eval':
                const code = msgContent["code"];

                if (typeof code !== "string") {
                    logError(this, "onCustomPacketMessage expected 'code' to be a string", "code:", code);
                    break;
                }
                this.processEval(code);
                break;
        }
    }

    private processEval(code: string): void {
        // Consider removing try catch
        try {
            const src = code;

            const serverJsVerificationService = this.controller.lookupListener(ServerJsVerificationService);

            const prefix = "// skymp:sig:y:GM";

            const result = serverJsVerificationService.verifyServerJs(src, prefix);

            if (result.src && !result.error) {
                this.controller.once("update", () => {
                    const remoteServer = this.controller.lookupListener(RemoteServer);
                    const worldModel = remoteServer.getWorldModel();
                    const myFormModel = worldModel.forms[worldModel.playerCharacterFormIdx];

                    const ctx: Partial<GamemodeApiCtx> = {
                        sp: sp,
                        _model: myFormModel,
                        getFormIdInServerFormat: localIdToRemoteId,
                        getMyFormIdInServerFormat: () => remoteServer.getMyRemoteRefrId(),
                        getFormIdInClientFormat: remoteIdToLocalId,
                        get(propName: string) {
                            return (this._model as Record<string, any>)?.[propName];
                        }
                    };
                    (new Function('ctx', result.src))(ctx);
                });
                printConsole("Eval executed successfully");
            } else {
                logError(this, "processEval failed server JS verification", "error:", result.error, "src:", src);
            }

        } catch (e) {
            logError(this, "processEval error", e);
        }
    }
}
