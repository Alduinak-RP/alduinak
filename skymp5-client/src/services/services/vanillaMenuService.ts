import { Menu } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";

// Paths and members of SkyUI's quest_journal.swf (SkyUI_SE.bsa wins over Skyrim - Interface.bsa)
const JOURNAL_ROOT = "_root.QuestJournalFader.Menu_mc";
// Quest_Journal.PAGE_SYSTEM, the last tab
const SYSTEM_TAB = 2;
const HIDDEN_JOURNAL_TABS = ["QuestsTab", "StatsTab", "TabButtonHelp"];
// Updates a menu may take to expose its movie before its paths count as missing
const MAX_PATH_MISSES = 10;
// Invokes run later on the UI queue, so a state the engine sets back is applied again a few times
const MAX_JOURNAL_SWITCHES = 5;
// Updates to wait after an invoke before reading the state it set
const INVOKE_SETTLE_UPDATES = 2;

interface JournalState {
  misses: number;
  settle: number;
  switches: number;
  tabsHidden: boolean;
  failed: boolean;
}

// Trims the vanilla menus the browser menus replace, through the menus' own ActionScript
export class VanillaMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Journal) this.journal = { misses: 0, settle: 0, switches: 0, tabsHidden: false, failed: false };
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Journal) this.journal = undefined;
    });
    this.controller.on("update", () => this.onUpdate());
  }

  private onUpdate(): void {
    if (this.journal && !this.journal.failed) this.trimJournal(this.journal);
  }

  // Esc and J both land on the System page with the other tabs gone, the state RestoreSavedSettings sets when the engine disables tabs
  private trimJournal(j: JournalState): void {
    if (j.settle > 0) {
      j.settle--;
      return;
    }
    const ui = this.sp.Ui;
    const at = (member: string) => `${JOURNAL_ROOT}.${member}`;
    if (ui.getString(Menu.Journal, at("SystemTab._name")) !== "SystemTab") {
      if (++j.misses > MAX_PATH_MISSES) this.failJournal(j, `${at("SystemTab")} not found`);
      return;
    }
    const tab = ui.getInt(Menu.Journal, at("iCurrentTab"));
    if (!ui.getBool(Menu.Journal, at("bTabsDisabled")) || tab !== SYSTEM_TAB) {
      if (++j.switches > MAX_JOURNAL_SWITCHES) return this.failJournal(j, `stays on tab ${tab}`);
      // ShiftTab ends the open page first, so its bottom bar listeners do not follow onto System
      if (tab !== SYSTEM_TAB) ui.invokeInt(Menu.Journal, at("ShiftTab"), SYSTEM_TAB - tab);
      // With tabs disabled the saved tab argument is ignored and the last tab is used
      ui.invokeBoolA(Menu.Journal, at("RestoreSavedSettings"), [true, true]);
      j.settle = INVOKE_SETTLE_UPDATES;
      return;
    }
    if (!j.tabsHidden) {
      j.tabsHidden = true;
      const statsX = ui.getFloat(Menu.Journal, at("StatsTab._x"));
      const statsWidth = ui.getFloat(Menu.Journal, at("StatsTab._width"));
      const systemWidth = ui.getFloat(Menu.Journal, at("SystemTab._width"));
      ui.setFloat(Menu.Journal, at("SystemTab._x"), statsX + (statsWidth - systemWidth) / 2);
      for (const clip of HIDDEN_JOURNAL_TABS) ui.setBool(Menu.Journal, at(`${clip}._visible`), false);
      this.logOnce("journal", `Journal Menu shows System only, hid ${HIDDEN_JOURNAL_TABS.join(", ")}`);
    }
  }

  private failJournal(j: JournalState, why: string): void {
    j.failed = true;
    this.logOnce(`journal:${why}`, `Journal Menu left as it is: ${why}`);
  }

  private logOnce(key: string, text: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    logToPlatformLog(this, text);
  }

  private journal?: JournalState;
  private logged = new Set<string>();
}
