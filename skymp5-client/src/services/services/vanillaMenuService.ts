import { Menu } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { keepMenusClosed } from "./menuBlockUtil";

// Paths and members of SkyUI's quest_journal.swf (SkyUI_SE.bsa wins over Skyrim - Interface.bsa)
const JOURNAL_ROOT = "_root.QuestJournalFader.Menu_mc";
// Quest_Journal.PAGE_SYSTEM, the last tab
const SYSTEM_TAB = 2;
const HIDDEN_JOURNAL_TABS = ["QuestsTab", "StatsTab", "TabButtonHelp"];
const SYSTEM_LIST_HOLDER = `${JOURNAL_ROOT}.SystemFader.Page_mc.CategoryList_mc`;
// A Shared.CenteredScrollingList, which shows and steps through only the entries its filterer matches
const SYSTEM_LIST = `${SYSTEM_LIST_HOLDER}.List_mc`;
// Text keys of the System entries to drop; $MOD MANAGER reads CREATIONS
const HIDDEN_SYSTEM_ENTRIES = ["$QUICKSAVE", "$SAVE", "$LOAD", "$INSTALLED CONTENT", "$MOD MANAGER", "$MOD CONFIGURATION", "$HELP"];
// Paths and members of SkyUI's tweenmenu.swf
const TWEEN_ROOT = "_root.TweenMenu_mc";
// TweenMenu.FrameToLabelMap[1]: the Selections_mc frame label that Up (and the Skills rect) highlights
const TWEEN_SKILLS_LABEL = "_global.TweenMenu.FrameToLabelMap.1";
// Selections_mc frame of the "Skills" label
const TWEEN_SKILLS_FRAME = 2;
// Updates a menu may take to expose its movie before its paths count as missing
const MAX_PATH_MISSES = 10;
// Invokes run later on the UI queue, so a state the engine sets back is applied again a few times
const MAX_JOURNAL_SWITCHES = 5;
// Updates to wait after an invoke before reading the state it set
const INVOKE_SETTLE_UPDATES = 2;

interface TweenState {
  misses: number;
  trimmed: boolean;
}

interface JournalState {
  misses: number;
  settle: number;
  switches: number;
  tabsHidden: boolean;
  entryCount: number;
  listHidden: boolean;
  failed: boolean;
}

// Trims the vanilla menus the browser menus replace, through the menus' own ActionScript
export class VanillaMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Journal) {
        this.journal = { misses: 0, settle: 0, switches: 0, tabsHidden: false, entryCount: -1, listHidden: false, failed: false };
      }
    });
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Tween) this.tween = { misses: 0, trimmed: false };
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Journal) this.journal = undefined;
      if (e.name === Menu.Tween) this.tween = undefined;
    });
    this.controller.on("update", () => this.onUpdate());
    // SkyrimPlatform drops the Quick Stats key and the Tween Menu has no Skills; anything else that opens StatsMenu is shut at once
    keepMenusClosed(this.sp, this.controller, [Menu.Stats], () => this.logOnce("stats", "StatsMenu opened and was closed at once"));
  }

  private onUpdate(): void {
    if (this.journal && !this.journal.failed) this.trimJournal(this.journal);
    if (this.tween) this.trimTween(this.tween);
  }

  // Up and the Skills rect highlight the "None" frame, so a second Up or Enter never reaches OpenHighlightedMenu(1)
  private trimTween(t: TweenState): void {
    const ui = this.sp.Ui;
    const at = (member: string) => `${TWEEN_ROOT}.${member}`;
    if (!t.trimmed) {
      if (ui.getString(Menu.Tween, at("SkillsInputRect._name")) !== "SkillsInputRect") {
        if (++t.misses > MAX_PATH_MISSES) {
          this.tween = undefined;
          this.logOnce("tween:missing", `Tween Menu left as it is: ${at("SkillsInputRect")} not found`);
        }
        return;
      }
      t.trimmed = true;
      const label = ui.getString(Menu.Tween, TWEEN_SKILLS_LABEL);
      ui.setString(Menu.Tween, TWEEN_SKILLS_LABEL, "None");
      const remapped = ui.getString(Menu.Tween, TWEEN_SKILLS_LABEL) === "None";
      ui.setBool(Menu.Tween, at("Selections_mc.SkillsText_mc._visible"), false);
      // onMouseDown reaches every clip, hidden or not, so the rect's handlers are replaced
      ui.setBool(Menu.Tween, at("SkillsInputRect.onMouseDown"), false);
      ui.setBool(Menu.Tween, at("SkillsInputRect.onRollOver"), false);
      ui.setBool(Menu.Tween, at("SkillsInputRect._visible"), false);
      this.logOnce("tween", `Tween Menu hides Skills; Up highlights ${remapped ? "nothing" : `"${label}", reset each update`}`);
    }
    // Backstop for a highlight that still reached the Skills frame
    if (ui.getInt(Menu.Tween, at("Selections_mc._currentframe")) === TWEEN_SKILLS_FRAME) {
      ui.invokeString(Menu.Tween, at("Selections_mc.gotoAndStop"), "None");
    }
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
      // The System page may add entries when it starts, so its list stays unseen until they are trimmed
      this.setSystemListShown(j, false);
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
    this.trimSystemEntries(j);
  }

  // Filtered entries keep their indices, so the page's IDX_ members and SetSaveDisabled still line up
  private trimSystemEntries(j: JournalState): void {
    const ui = this.sp.Ui;
    const count = ui.getInt(Menu.Journal, `${SYSTEM_LIST}.entryList.length`);
    if (count === j.entryCount) {
      this.setSystemListShown(j, true);
      return;
    }
    this.setSystemListShown(j, false);
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      const entry = `${SYSTEM_LIST}.entryList.${i}`;
      const text = ui.getString(Menu.Journal, `${entry}.text`);
      texts.push(text);
      // ListFilterer.EntryMatchesFilter fails an entry whose filterFlag has no bit of its filter
      if (HIDDEN_SYSTEM_ENTRIES.includes(text)) ui.setInt(Menu.Journal, `${entry}.filterFlag`, 0);
    }
    if (!texts.some(Boolean)) return this.failJournal(j, `${SYSTEM_LIST}.entryList unreadable (${count} entries)`);
    ui.invokeBool(Menu.Journal, `${SYSTEM_LIST}.InvalidateData`, false);
    j.entryCount = count;
    j.settle = INVOKE_SETTLE_UPDATES;
    const kept = texts.filter((text) => !HIDDEN_SYSTEM_ENTRIES.includes(text));
    const dropped = texts.filter((text) => HIDDEN_SYSTEM_ENTRIES.includes(text));
    this.logOnce(`system:${texts.join()}`, `System page keeps ${kept.join(", ")}, hid ${dropped.join(", ")}`);
  }

  private setSystemListShown(j: JournalState, shown: boolean): void {
    if (j.listHidden !== shown) return;
    j.listHidden = !shown;
    this.sp.Ui.setFloat(Menu.Journal, `${SYSTEM_LIST_HOLDER}._alpha`, shown ? 100 : 0);
  }

  private failJournal(j: JournalState, why: string): void {
    j.failed = true;
    this.setSystemListShown(j, true);
    this.logOnce(`journal:${why}`, `Journal Menu left as it is: ${why}`);
  }

  private logOnce(key: string, text: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    logToPlatformLog(this, text);
  }

  private journal?: JournalState;
  private tween?: TweenState;
  private logged = new Set<string>();
}
