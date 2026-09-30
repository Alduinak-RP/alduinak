import { Menu } from "skyrimPlatform";
import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";

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
// BSScrollingList's own array behind its entryList getter
const SYSTEM_ENTRIES = `${SYSTEM_LIST}.EntriesA`;
// Text keys of the System entries to drop; $MOD MANAGER reads CREATIONS
const HIDDEN_SYSTEM_ENTRIES = ["$QUICKSAVE", "$SAVE", "$LOAD", "$INSTALLED CONTENT", "$MOD MANAGER", "$MOD CONFIGURATION", "$HELP"];
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

interface JournalState {
  misses: number;
  settle: number;
  switches: number;
  // SystemTab._x from before it was centred, set once the other clips are hidden
  systemTabX?: number;
  onSystem: boolean;
  // Entry texts joined, as of the last trim
  entrySignature?: string;
  // entryList indices of the filtered out entries
  hiddenEntries: number[];
  listHidden: boolean;
  reachChecked: boolean;
  reachMisses: number;
  failed: boolean;
}

interface NativeMenuList {
  hideMenuListEntries?: (menuName: string, entriesPath: string, texts: string[]) => string[] | null;
}

// Trims the vanilla menus the browser menus replace, through the menus' own ActionScript
export class VanillaMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Journal) {
        this.journal = { misses: 0, settle: 0, switches: 0, onSystem: false, hiddenEntries: [], listHidden: false, reachChecked: false, reachMisses: 0, failed: false };
        // menuOpen runs as a task after this update's handler, so the first pass is not left to the next update
        this.trimJournal(this.journal);
      }
      if (e.name === Menu.HUD) this.hudDirty = true;
      if (e.name === Menu.Stats) this.logOnce("stats", "Skills menu (StatsMenu) opened");
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Journal) this.journal = undefined;
      if (e.name === Menu.Loading) this.hudDirty = true;
    });
    this.controller.emitter.on("uiHiddenChanged", (e) => {
      this.hudHidden = e.hidden;
      this.hudDirty = true;
    });
    this.controller.on("update", () => this.onUpdate());
  }

  private onUpdate(): void {
    if (this.journal && !this.journal.failed) this.trimJournal(this.journal);
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
    const { texts, via } = this.hideSystemEntries();
    if (!texts) return this.failJournal(j, `${SYSTEM_ENTRIES} is not an array`);
    const signature = texts.join("|");
    if (signature === j.entrySignature) {
      this.setSystemListShown(j, true);
      this.keepSystemSelectionShown(j);
      this.checkSystemReach(j, texts.length);
      return;
    }
    this.setSystemListShown(j, false);
    if (!texts.some(Boolean)) return this.failJournal(j, `${SYSTEM_ENTRIES} unreadable (${texts.length} entries)`);
    j.hiddenEntries = [];
    texts.forEach((text, i) => {
      if (HIDDEN_SYSTEM_ENTRIES.includes(text)) j.hiddenEntries.push(i);
    });
    // Up from the top entry would focus the hidden tab row, from which Down selects entryList[scrollPosition]
    this.sp.Ui.setBool(Menu.Journal, `${SYSTEM_LIST}.bAllowUpToTabs`, false);
    this.redrawSystemList(j);
    j.entrySignature = signature;
    j.reachChecked = false;
    j.reachMisses = 0;
    const kept = texts.filter((text) => !HIDDEN_SYSTEM_ENTRIES.includes(text));
    const dropped = texts.filter((text) => HIDDEN_SYSTEM_ENTRIES.includes(text));
    this.logOnce(`system:${signature}`, `System page keeps ${kept.join(", ")}, hid ${dropped.join(", ")} (${via})`);
  }

  // SkyrimPlatform writes filterFlag on the entry objects through GFxValue; an older SkyrimPlatformImpl.dll leaves SKSE's UI paths
  private hideSystemEntries(): { texts: string[] | null; via: string } {
    const native = (this.sp as unknown as NativeMenuList).hideMenuListEntries;
    if (native) {
      try {
        const texts = native(Menu.Journal, SYSTEM_ENTRIES, HIDDEN_SYSTEM_ENTRIES);
        if (texts) this.probePapyrusPaths(texts.length);
        return { texts, via: "native" };
      } catch (e) {
        this.logOnce("system:native-error", `hideMenuListEntries failed (${e}), hiding System entries through Papyrus paths`);
      }
    } else {
      this.logOnce("system:native-missing", "hideMenuListEntries missing (SkyrimPlatformImpl.dll older than r26), hiding System entries through Papyrus paths");
    }
    const ui = this.sp.Ui;
    const texts: string[] = [];
    const count = ui.getInt(Menu.Journal, `${SYSTEM_LIST}.entryList.length`);
    for (let i = 0; i < count; i++) {
      const entry = `${SYSTEM_LIST}.entryList.${i}`;
      const text = ui.getString(Menu.Journal, `${entry}.text`);
      texts.push(text);
      // ListFilterer.EntryMatchesFilter fails an entry whose filterFlag has no bit of its filter
      if (HIDDEN_SYSTEM_ENTRIES.includes(text)) ui.setInt(Menu.Journal, `${entry}.filterFlag`, 0);
    }
    return { texts, via: "Papyrus paths" };
  }

  // Once a session: whether SKSE's UI natives read and write the entry objects through entryList paths
  private probePapyrusPaths(count: number): void {
    if (this.logged.has("system:probe")) return;
    const ui = this.sp.Ui;
    const read = ui.getInt(Menu.Journal, `${SYSTEM_LIST}.entryList.length`);
    const probe = `${SYSTEM_LIST}.entryList.0.aldProbe`;
    ui.setInt(Menu.Journal, probe, 1);
    const wrote = ui.getInt(Menu.Journal, probe);
    this.logOnce("system:probe", `Papyrus paths through entryList read ${read} of ${count} entries, a member written to entry 0 reads back ${wrote}`);
  }

  // CalculateMaxScrollPosition counts only the entries the filterer lets through
  private checkSystemReach(j: JournalState, total: number): void {
    if (j.reachChecked) return;
    const reach = this.sp.Ui.getInt(Menu.Journal, `${SYSTEM_LIST}.iMaxScrollPosition`) + 1;
    const expected = total - j.hiddenEntries.length;
    if (reach !== expected && ++j.reachMisses <= MAX_PATH_MISSES) return;
    j.reachChecked = true;
    const verdict = reach === expected ? "" : `, expected ${expected}: the hidden entries still show`;
    this.logOnce(`system:reach:${reach}/${total}`, `System list reaches ${reach} of ${total} entries${verdict}`);
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
  private hudHidden = false;
  // True while the HUD clips were last written hidden
  private hudWritten = false;
  private hudDirty = false;
  private hudCheckAt = 0;
  private logged = new Set<string>();
}
