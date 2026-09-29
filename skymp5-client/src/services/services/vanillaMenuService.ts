import { Menu } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { keepMenusClosed } from "./menuBlockUtil";

// Paths and members of SkyUI's quest_journal.swf (SkyUI_SE.bsa wins over Skyrim - Interface.bsa)
const JOURNAL_ROOT = "_root.QuestJournalFader.Menu_mc";
const journalAt = (member: string) => `${JOURNAL_ROOT}.${member}`;
// Quest_Journal.PAGE_SYSTEM, the last tab
const SYSTEM_TAB = 2;
// The other tabs, the tab key help and the pages behind those tabs
const HIDDEN_JOURNAL_CLIPS = ["QuestsTab", "StatsTab", "TabButtonHelp", "QuestsFader", "StatsFader"];
const SYSTEM_PAGE = `${JOURNAL_ROOT}.SystemFader.Page_mc`;
// SystemPage.MAIN_STATE, the only state in which the page makes its category list interactive
const SYSTEM_MAIN_STATE = 0;
const SYSTEM_LIST_HOLDER = `${SYSTEM_PAGE}.CategoryList_mc`;
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
// hudmenu.swf's movie; SkyUI's widget manager puts its widgets in WidgetContainer beside it
const HUD_ROOT = "_root.HUDMovieBaseInstance";
const HUD_CLIPS = [HUD_ROOT, "_root.WidgetContainer"];
const HUD_RECHECK_MS = 1000;
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
  // SystemTab._x from before it was centred, set once the other clips are hidden
  systemTabX?: number;
  onSystem: boolean;
  entryCount: number;
  // entryList indices of the filtered out entries
  hiddenEntries: number[];
  listHidden: boolean;
  failed: boolean;
}

// Trims the vanilla menus the browser menus replace, through the menus' own ActionScript
export class VanillaMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Journal) {
        this.journal = { misses: 0, settle: 0, switches: 0, onSystem: false, entryCount: -1, hiddenEntries: [], listHidden: false, failed: false };
        // menuOpen runs as a task after this update's handler, so the first pass is not left to the next update
        this.trimJournal(this.journal);
      }
      if (e.name === Menu.Tween) this.tween = { misses: 0, trimmed: false };
      if (e.name === Menu.HUD) this.hudDirty = true;
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Journal) this.journal = undefined;
      if (e.name === Menu.Tween) this.tween = undefined;
      if (e.name === Menu.Loading) this.hudDirty = true;
    });
    this.controller.emitter.on("uiHiddenChanged", (e) => {
      this.hudHidden = e.hidden;
      this.hudDirty = true;
    });
    this.controller.on("update", () => this.onUpdate());
    // SkyrimPlatform drops the Quick Stats key and the Tween Menu has no Skills; anything else that opens StatsMenu is shut at once
    keepMenusClosed(this.sp, this.controller, [Menu.Stats], () => this.logOnce("stats", "StatsMenu opened and was closed at once"));
  }

  private onUpdate(): void {
    if (this.journal && !this.journal.failed) this.trimJournal(this.journal);
    if (this.tween) this.trimTween(this.tween);
    this.syncHud();
  }

  // The hide UI key also hides the vanilla HUD (compass, bars, crosshair, messages and SkyUI widgets); a new HUD movie or a script that shows it again is hidden once more
  private syncHud(): void {
    if (!this.hudHidden && !this.hudWritten) return;
    const ui = this.sp.Ui;
    if (!ui.isMenuOpen(Menu.HUD)) return;
    const now = Date.now();
    if (!this.hudDirty) {
      if (!this.hudHidden || now < this.hudCheckAt) return;
      this.hudCheckAt = now + HUD_RECHECK_MS;
      if (!ui.getBool(Menu.HUD, `${HUD_ROOT}._visible`)) return;
      this.logOnce("hud:reshown", "HUD Menu was visible again while the interface is hidden, hid it again");
    }
    this.hudDirty = false;
    this.hudCheckAt = now + HUD_RECHECK_MS;
    if (ui.getString(Menu.HUD, `${HUD_ROOT}._name`) !== "HUDMovieBaseInstance") {
      this.logOnce("hud:missing", `HUD Menu left as it is: ${HUD_ROOT} not found`);
      return;
    }
    for (const clip of HUD_CLIPS) ui.setBool(Menu.HUD, `${clip}._visible`, !this.hudHidden);
    this.hudWritten = this.hudHidden;
    if (this.hudHidden) this.logOnce("hud", `HUD Menu hidden with the interface (${HUD_CLIPS.join(", ")})`);
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
    if (ui.getString(Menu.Journal, journalAt("SystemTab._name")) !== "SystemTab") {
      if (++j.misses > MAX_PATH_MISSES) this.failJournal(j, `${journalAt("SystemTab")} not found`);
      return;
    }
    // Hidden at once, as the switch to System lands only when the queued invokes run
    if (j.systemTabX === undefined) {
      j.systemTabX = ui.getFloat(Menu.Journal, journalAt("SystemTab._x"));
      this.setJournalClipsShown(false);
      this.centreSystemTab();
    }
    const tab = ui.getInt(Menu.Journal, journalAt("iCurrentTab"));
    if (!ui.getBool(Menu.Journal, journalAt("bTabsDisabled")) || tab !== SYSTEM_TAB) {
      if (++j.switches > MAX_JOURNAL_SWITCHES) return this.failJournal(j, `stays on tab ${tab}`);
      // ShiftTab ends the open page first, so its bottom bar listeners do not follow onto System
      if (tab !== SYSTEM_TAB) ui.invokeInt(Menu.Journal, journalAt("ShiftTab"), SYSTEM_TAB - tab);
      // With tabs disabled the saved tab argument is ignored and the last tab is used
      ui.invokeBoolA(Menu.Journal, journalAt("RestoreSavedSettings"), [true, true]);
      // The System page may add entries when it starts, so its list stays unseen until they are trimmed
      this.setSystemListShown(j, false);
      j.settle = INVOKE_SETTLE_UPDATES;
      return;
    }
    if (!j.onSystem) {
      j.onSystem = true;
      // The selected tab can draw at another width
      this.centreSystemTab();
      this.logOnce("journal", `Journal Menu shows System only, hid ${HIDDEN_JOURNAL_CLIPS.join(", ")}`);
    }
    this.trimSystemEntries(j);
  }

  private setJournalClipsShown(shown: boolean): void {
    for (const clip of HIDDEN_JOURNAL_CLIPS) this.sp.Ui.setBool(Menu.Journal, journalAt(`${clip}._visible`), shown);
  }

  // SystemTab takes the middle slot, StatsTab's
  private centreSystemTab(): void {
    const ui = this.sp.Ui;
    const statsX = ui.getFloat(Menu.Journal, journalAt("StatsTab._x"));
    const statsWidth = ui.getFloat(Menu.Journal, journalAt("StatsTab._width"));
    const systemWidth = ui.getFloat(Menu.Journal, journalAt("SystemTab._width"));
    ui.setFloat(Menu.Journal, journalAt("SystemTab._x"), statsX + (statsWidth - systemWidth) / 2);
  }

  // Filtered entries keep their indices, so the page's IDX_ members and SetSaveDisabled still line up
  private trimSystemEntries(j: JournalState): void {
    const ui = this.sp.Ui;
    const count = ui.getInt(Menu.Journal, `${SYSTEM_LIST}.entryList.length`);
    if (count === j.entryCount) {
      this.setSystemListShown(j, true);
      this.keepSystemSelectionShown(j);
      return;
    }
    this.setSystemListShown(j, false);
    const texts: string[] = [];
    j.hiddenEntries = [];
    for (let i = 0; i < count; i++) {
      const entry = `${SYSTEM_LIST}.entryList.${i}`;
      const text = ui.getString(Menu.Journal, `${entry}.text`);
      texts.push(text);
      if (!HIDDEN_SYSTEM_ENTRIES.includes(text)) continue;
      // ListFilterer.EntryMatchesFilter fails an entry whose filterFlag has no bit of its filter
      ui.setInt(Menu.Journal, `${entry}.filterFlag`, 0);
      j.hiddenEntries.push(i);
    }
    if (!texts.some(Boolean)) return this.failJournal(j, `${SYSTEM_LIST}.entryList unreadable (${count} entries)`);
    this.redrawSystemList(j);
    j.entryCount = count;
    const kept = texts.filter((text) => !HIDDEN_SYSTEM_ENTRIES.includes(text));
    const dropped = texts.filter((text) => HIDDEN_SYSTEM_ENTRIES.includes(text));
    this.logOnce(`system:${texts.join()}`, `System page keeps ${kept.join(", ")}, hid ${dropped.join(", ")}`);
  }

  // Returning from the tab row selects entryList index scrollPosition, a hidden entry while Settings is centred at 0
  private keepSystemSelectionShown(j: JournalState): void {
    const ui = this.sp.Ui;
    const selected = ui.getInt(Menu.Journal, `${SYSTEM_LIST}.iSelectedIndex`);
    if (selected !== -1 && !j.hiddenEntries.includes(selected)) return;
    // No selection is right only while the tab row has focus
    if (ui.getBool(Menu.Journal, `${SYSTEM_LIST}.bNoSelectionMode`)) return;
    this.redrawSystemList(j);
  }

  // On PC UpdateList keeps the old selection, which can be a hidden entry, unless asked to recentre
  private redrawSystemList(j: JournalState): void {
    const ui = this.sp.Ui;
    ui.setBool(Menu.Journal, `${SYSTEM_LIST}.bRecenterSelection`, true);
    ui.invokeBool(Menu.Journal, `${SYSTEM_LIST}.InvalidateData`, false);
    j.settle = INVOKE_SETTLE_UPDATES;
  }

  // An unseen list still takes keys and clicks on its untrimmed entries, so it is not interactive until shown
  private setSystemListShown(j: JournalState, shown: boolean): void {
    const ui = this.sp.Ui;
    if (!shown) {
      ui.setBool(Menu.Journal, `${SYSTEM_LIST}.bDisableInput`, true);
      // Queued after a ShiftTab, whose startPage makes the list interactive again
      ui.invokeBool(Menu.Journal, `${SYSTEM_LIST}.setInteractive`, false);
    }
    if (j.listHidden !== shown) return;
    j.listHidden = !shown;
    ui.setFloat(Menu.Journal, `${SYSTEM_LIST_HOLDER}._alpha`, shown ? 100 : 0);
    // Other states keep the list disabled so a click on it reads as going back
    if (shown && ui.getInt(Menu.Journal, `${SYSTEM_PAGE}.iCurrentState`) === SYSTEM_MAIN_STATE) {
      ui.invokeBool(Menu.Journal, `${SYSTEM_LIST}.setInteractive`, true);
    }
  }

  private failJournal(j: JournalState, why: string): void {
    j.failed = true;
    this.setSystemListShown(j, true);
    if (j.systemTabX !== undefined) {
      this.sp.Ui.setFloat(Menu.Journal, journalAt("SystemTab._x"), j.systemTabX);
      this.setJournalClipsShown(true);
    }
    this.logOnce(`journal:${why}`, `Journal Menu left as it is: ${why}`);
  }

  private logOnce(key: string, text: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    logToPlatformLog(this, text);
  }

  private journal?: JournalState;
  private tween?: TweenState;
  private hudHidden = false;
  // True while the HUD clips were last written hidden
  private hudWritten = false;
  private hudDirty = false;
  private hudCheckAt = 0;
  private logged = new Set<string>();
}
