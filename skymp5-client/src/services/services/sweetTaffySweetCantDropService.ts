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
            // hasKeyword(null) is true for any peak value modifier effect without a keyword, so a missing keyword is never passed
            const keyword = this.sp.Keyword.getKeyword(this.cantDropKeyword);
            if (!keyword) {
                return true;
            }
            const item = this.sp.Game.getFormEx(itemId);
            return !item || !item.hasKeyword(keyword);
        } catch (e) {
            logError(this, `canDropOrPutItem failed for ${itemId.toString(16)}:`, e);
            return true;
        }
    }

    private cantDropKeyword = "SweetCantDrop";
}
