import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError } from "../../logging";

// TODO: move to the server/gamemode
export class SweetTaffySweetCantDropService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
    }

    // Fails open: the server refuses SweetCantDrop items itself
    public canDropOrPutItem(itemId: number): boolean {
        try {
            const item = this.sp.Game.getFormEx(itemId);
            return !item || !item.hasKeyword(this.sp.Keyword.getKeyword(this.cantDropKeyword));
        } catch (e) {
            logError(this, `canDropOrPutItem failed for ${itemId.toString(16)}:`, e);
            return true;
        }
    }

    private cantDropKeyword = "SweetCantDrop";
}
