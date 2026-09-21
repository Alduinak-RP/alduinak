using System.Reflection;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;

// AlduinakCreations.esp: ESL-flagged overrides keeping only the Creation Club items and tiering their recipes (see README.md)
static class Creations
{
    public static HashSet<ModKey> Named(JsonObject? cs) =>
        (cs?["plugins"]?.AsArray().Select(x => ModKey.FromNameAndExtension(x!.GetValue<string>())) ?? Enumerable.Empty<ModKey>()).ToHashSet();

    // The Creation plugins to build apart; none when skip leaves AlduinakCreations.esp out, so they stay in the load order
    public static HashSet<ModKey> PluginKeys(JsonObject? cs, List<string> loadOrder, bool skip)
    {
        var names = cs?["plugins"]?.AsArray().Select(x => x!.GetValue<string>()).ToList() ?? new List<string>();
        if (skip && names.Count > 0) Console.WriteLine($"creations: --no-creations, {cs!["pluginName"]} is not built");
        if (skip) return new HashSet<ModKey>();
        var present = names.Where(n => loadOrder.Any(l => string.Equals(l, n, StringComparison.OrdinalIgnoreCase))).ToList();
        if (present.Count == 0 && names.Count > 0)
            throw new Exception($"creations: the load order carries none of {string.Join(", ", names)}; insert them right after Dragonborn.esm, or pass --no-creations to leave {cs!["pluginName"]} out of this run");
        if (present.Count == 0) return new HashSet<ModKey>();
        if (present.Count != names.Count)
            throw new Exception($"creations: the load order carries only {string.Join(", ", present)} of {string.Join(", ", names)}");
        return present.Select(n => ModKey.FromNameAndExtension(n)).ToHashSet();
    }

    public static bool Build(JsonObject spec, JsonObject cs, IEnumerable<IModListingGetter<ISkyrimModGetter>> listed, SkyrimMod additions, HashSet<ModKey> cc, string outDir, string reportDir)
    {
        var key = ModKey.FromNameAndExtension(cs["pluginName"]!.GetValue<string>());
        // The patched AlduinakAdditions.esp replaces the file on disk, so the recipes find the marker spells it now holds
        var listings = listed.Select(l => l.ModKey == additions.ModKey ? new ModListing<ISkyrimModGetter>(additions, true, "") : l).ToList();
        var full = new LoadOrder<IModListingGetter<ISkyrimModGetter>>(listings);
        // Every non-Creation plugin loads after the Creations, so this cache's winners are the records as if the Creations were absent
        var baseline = new LoadOrder<IModListingGetter<ISkyrimModGetter>>(listings.Where(l => !cc.Contains(l.ModKey)));
        var run = new CreationsRun(new SkyrimMod(key, SkyrimRelease.SkyrimSE), full.ToImmutableLinkCache(), baseline.ToImmutableLinkCache(), full, cc, cs, new Report(0, key));
        run.Mod.ModHeader.Flags |= SkyrimModHeader.HeaderFlag.Small;
        var ccMods = listings.Where(l => cc.Contains(l.ModKey)).Select(l => l.Mod ?? throw new Exception($"{l.ModKey} is not in the data folder")).ToList();

        run.Quests(ccMods);
        run.StoryManager(ccMods);
        run.LoadScreens(ccMods);
        run.Globals();
        run.StageAbilities();
        run.PlacedReferences(ccMods);
        run.Reverts(ccMods);
        run.FoodHunger(ccMods);
        run.Recipes(spec, additions.ModKey);
        run.CellFields();
        run.CheckOverridesOnly();

        if (run.Report.Errors.Count > 0)
        {
            Console.WriteLine($"creations: {run.Report.Errors.Count} error(s):");
            foreach (var e in run.Report.Errors) Console.WriteLine("  " + e);
            run.Report.Write(reportDir, run.Mod, full, failed: true, reportName: "creations-report.md");
            return false;
        }
        var outPath = Path.Combine(outDir, key.FileName);
        run.Mod.WriteToBinary(outPath, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.Iterate,
            MastersListOrdering = new MastersListOrderingByLoadOrder(listings.Select(l => l.ModKey)),
            ModKey = ModKeyOption.NoCheck,
            RecordCount = RecordCountOption.Iterate,
            NextFormID = NextFormIDOption.Iterate,
        });
        Console.WriteLine($"wrote {outPath} ({new FileInfo(outPath).Length} bytes, {run.Mod.EnumerateMajorRecords().Count()} overrides)");
        run.Report.Write(reportDir, run.Mod, full, failed: false, reportName: "creations-report.md");
        Directory.CreateDirectory(reportDir);
        File.WriteAllText(Path.Combine(reportDir, "creations-food-hunger.md"), run.FoodTable());
        return true;
    }
}

class CreationsRun
{
    const int FlagDeleted = 0x20;
    const int FlagInitiallyDisabled = 0x800;

    public readonly SkyrimMod Mod;
    public readonly Report Report;
    readonly ILinkCache<ISkyrimMod, ISkyrimModGetter> full;
    readonly ILinkCache<ISkyrimMod, ISkyrimModGetter> baseline;
    readonly ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> fullOrder;
    readonly HashSet<ModKey> cc;
    readonly JsonObject cs;
    // Cells and worldspaces the Creations edit; their fields go back to the baseline even when no child needs an override
    readonly HashSet<FormKey> editedContainers = new();

    public CreationsRun(SkyrimMod mod, ILinkCache<ISkyrimMod, ISkyrimModGetter> full, ILinkCache<ISkyrimMod, ISkyrimModGetter> baseline,
                        ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> fullOrder, HashSet<ModKey> cc, JsonObject cs, Report report)
    {
        Mod = mod; this.full = full; this.baseline = baseline; this.fullOrder = fullOrder; this.cc = cc; this.cs = cs; Report = report;
    }

    bool Own(IMajorRecordGetter r) => cc.Contains(r.FormKey.ModKey);

    static ConditionFloat Never() => new()
    {
        CompareOperator = CompareOperator.LessThan,
        ComparisonValue = 0f,
        Data = new GetRandomPercentConditionData { RunOnType = Condition.RunOnType.Subject },
    };

    public static string RecordType(IMajorRecordGetter r)
    {
        var reg = ((Loqui.ILoquiObject)r).Registration;
        var field = reg.GetType().GetField("TriggeringRecordType", BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
        return field?.GetValue(field.IsStatic ? null : reg) is RecordType t ? t.Type : reg.Name;
    }

    // ---- quests stop starting with the game ------------------------------------------------------------------------
    public void Quests(List<ISkyrimModGetter> ccMods)
    {
        foreach (var q in ccMods.SelectMany(m => m.Quests).Where(Own))
        {
            var winning = full.Resolve<IQuestGetter>(q.FormKey);
            if (!winning.Flags.HasFlag(Quest.Flag.StartGameEnabled)) continue;
            var o = Mod.Quests.GetOrAddAsOverride(winning);
            o.Flags &= ~Quest.Flag.StartGameEnabled;
            Report.Notes.Add($"QUST {q.EditorID} {q.FormKey}: Start Game Enabled cleared");
        }
    }

    // ---- story manager branches and quest nodes never pass ---------------------------------------------------------
    public void StoryManager(List<ISkyrimModGetter> ccMods)
    {
        foreach (var n in ccMods.SelectMany(m => m.StoryManagerBranchNodes).Where(Own))
        {
            var o = Mod.StoryManagerBranchNodes.GetOrAddAsOverride(full.Resolve<IStoryManagerBranchNodeGetter>(n.FormKey));
            o.Conditions.Clear();
            o.Conditions.Add(Never());
            Report.Notes.Add($"SMBN {n.EditorID} {n.FormKey}: conditions replaced by GetRandomPercent < 0");
        }
        foreach (var n in ccMods.SelectMany(m => m.StoryManagerQuestNodes).Where(Own))
        {
            var o = Mod.StoryManagerQuestNodes.GetOrAddAsOverride(full.Resolve<IStoryManagerQuestNodeGetter>(n.FormKey));
            o.Conditions.Clear();
            o.Conditions.Add(Never());
            Report.Notes.Add($"SMQN {n.EditorID} {n.FormKey}: conditions replaced by GetRandomPercent < 0");
        }
    }

    // ---- loading screens never show ---------------------------------------------------------------------------------
    public void LoadScreens(List<ISkyrimModGetter> ccMods)
    {
        foreach (var s in ccMods.SelectMany(m => m.LoadScreens).Where(Own))
        {
            var o = Mod.LoadScreens.GetOrAddAsOverride(full.Resolve<ILoadScreenGetter>(s.FormKey));
            o.Conditions.Clear();
            o.Conditions.Add(Never());
            Report.Notes.Add($"LSCR {s.EditorID} {s.FormKey}: conditions replaced by GetRandomPercent < 0");
        }
    }

    // ---- Survival switch and prompt globals pinned -------------------------------------------------------------------
    public void Globals()
    {
        foreach (var (edid, value) in (cs["globals"]?.AsObject() ?? new JsonObject()).Select(kv => (kv.Key, kv.Value!.GetValue<float>())))
        {
            if (!full.TryResolve<IGlobalGetter>(edid, out var g)) { Report.Errors.Add($"creations: global '{edid}' not found"); continue; }
            var o = Mod.Globals.GetOrAddAsOverride(g);
            o.RawFloat = value;
            Report.Notes.Add($"GLOB {edid} {g.FormKey}: {value}");
        }
    }

    // ---- the hunger stage abilities the server grants keep their gameplay effects but lose the screen effects -------
    public void StageAbilities()
    {
        if (cs["stageAbilities"] is not JsonObject sa) return;
        var suffix = sa["dropEffectsEndingWith"]!.GetValue<string>();
        foreach (var edid in sa["spells"]!.AsArray().Select(x => x!.GetValue<string>()))
        {
            if (!full.TryResolve<ISpellGetter>(edid, out var spell)) { Report.Errors.Add($"creations: stage ability '{edid}' not found"); continue; }
            var o = Mod.Spells.GetOrAddAsOverride(spell);
            var dropped = o.Effects.RemoveAll(e => full.TryResolve<IMagicEffectGetter>(e.BaseEffect.FormKey, out var mgef) && (mgef.EditorID ?? "").EndsWith(suffix, StringComparison.Ordinal));
            if (dropped == 0) Report.Errors.Add($"creations: stage ability '{edid}' has no effect ending with {suffix}");
            Report.Notes.Add($"SPEL {edid} {spell.FormKey}: {dropped} screen effect(s) removed, {o.Effects.Count} kept");
        }
    }

    // ---- every reference the Creations place starts disabled, with no enable parent to switch it back on ------------
    public void PlacedReferences(List<ISkyrimModGetter> ccMods)
    {
        var counts = new Dictionary<string, int[]>();
        void Count(string type, int slot) { if (!counts.TryGetValue(type, out var c)) counts[type] = c = new int[3]; c[slot]++; }
        foreach (var m in ccMods)
        {
            foreach (var ctx in m.EnumerateMajorRecordContexts<IPlacedObject, IPlacedObjectGetter>(full))
            {
                var r = ctx.Record;
                if (!Own(r)) continue;
                if ((r.MajorRecordFlagsRaw & FlagDeleted) != 0 || ((r.MajorRecordFlagsRaw & FlagInitiallyDisabled) != 0 && r.EnableParent == null)) { Count("REFR", 1); continue; }
                var o = ctx.GetOrAddAsOverride(Mod);
                o.MajorRecordFlagsRaw |= FlagInitiallyDisabled;
                o.EnableParent = null;
                Count("REFR", 0);
            }
            foreach (var ctx in m.EnumerateMajorRecordContexts<IPlacedNpc, IPlacedNpcGetter>(full))
            {
                var r = ctx.Record;
                if (!Own(r)) continue;
                if ((r.MajorRecordFlagsRaw & FlagDeleted) != 0 || ((r.MajorRecordFlagsRaw & FlagInitiallyDisabled) != 0 && r.EnableParent == null)) { Count("ACHR", 1); continue; }
                var o = ctx.GetOrAddAsOverride(Mod);
                o.MajorRecordFlagsRaw |= FlagInitiallyDisabled;
                o.EnableParent = null;
                Count("ACHR", 0);
            }
            foreach (var ctx in m.EnumerateMajorRecordContexts<IAPlacedTrap, IAPlacedTrapGetter>(full))
            {
                var r = ctx.Record;
                if (!Own(r)) continue;
                if ((r.MajorRecordFlagsRaw & FlagDeleted) != 0 || ((r.MajorRecordFlagsRaw & FlagInitiallyDisabled) != 0 && r.EnableParent == null)) { Count("PHZD", 1); continue; }
                var o = ctx.GetOrAddAsOverride(Mod);
                o.MajorRecordFlagsRaw |= FlagInitiallyDisabled;
                o.EnableParent = null;
                Count("PHZD", 0);
            }
        }
        foreach (var (type, c) in counts)
            Report.Notes.Add($"placed {type}: {c[0]} disabled, {c[1]} already disabled or deleted");
    }

    // ---- edits of master records go back to the record as it wins without the Creations -----------------------------
    public void Reverts(List<ISkyrimModGetter> ccMods)
    {
        var revert = Codes("revertTypes");
        var keep = Codes("keepTypes");
        var keepEdits = Codes("keepEdits");
        var done = new HashSet<FormKey>();
        foreach (var m in ccMods)
        {
            foreach (var r in m.EnumerateMajorRecords())
            {
                if (Own(r) || !done.Add(r.FormKey)) continue;
                var type = RecordType(r);
                var getter = ((Loqui.ILoquiObject)r).Registration.GetterType;
                if (!full.TryResolveSimpleContext(r.FormKey, getter, out var winner)) { Report.Errors.Add($"creations: {type} {r.FormKey} does not resolve"); continue; }
                if (!cc.Contains(winner.ModKey))
                {
                    Report.Notes.Add($"{type} {r.FormKey} {r.EditorID}: kept, {winner.ModKey} overrides it after the Creations");
                    continue;
                }
                if (type is "CELL" or "WRLD") { editedContainers.Add(r.FormKey); continue; }
                if (keep.Contains(type) || keepEdits.Contains(r.EditorID ?? "")) { Report.Notes.Add($"{type} {r.FormKey} {r.EditorID}: Creation edit kept ({winner.ModKey})"); continue; }
                if (!revert.Contains(type)) { Report.Errors.Add($"creations: {winner.ModKey} edits {type} {r.FormKey} {r.EditorID}, which is in neither revertTypes nor keepTypes"); continue; }
                if (!baseline.TryResolveContext(r.FormKey, getter, out var before)) { Report.Errors.Add($"creations: {type} {r.FormKey} has no record without the Creations"); continue; }
                before.GetOrAddAsOverride(Mod);
                Report.Notes.Add($"{type} {r.FormKey} {r.EditorID}: reverted to {before.ModKey} (was {winner.ModKey})");
            }
        }
    }

    // ---- hunger values: every food a Creation gave one keeps it, and foods no survey covered get one by Survival's categories ----
    readonly List<(string Key, string EditorId, string Winner, string Category, string Reason)> foodRows = new();

    public void FoodHunger(List<ISkyrimModGetter> ccMods)
    {
        if (cs["foodHunger"] is not JsonObject fh) return;
        var prefix = fh["effectPrefix"]!.GetValue<string>();
        var hunger = fullOrder.PriorityOrder.MagicEffect().WinningOverrides().Where(m => (m.EditorID ?? "").StartsWith(prefix, StringComparison.Ordinal)).Select(m => m.FormKey).ToHashSet();
        var category = new Dictionary<FormKey, string>();
        var effectOf = new Dictionary<string, IMagicEffectGetter>();
        foreach (var (cat, edid) in fh["effects"]!.AsObject().Select(kv => (kv.Key, kv.Value!.GetValue<string>())))
        {
            if (!full.TryResolve<IMagicEffectGetter>(edid, out var mgef)) { Report.Errors.Add($"creations: food hunger effect '{edid}' not found"); continue; }
            category[mgef.FormKey] = cat;
            effectOf[cat] = mgef;
        }
        bool HasHunger(IIngestibleGetter r) => r.Effects.Any(e => hunger.Contains(e.BaseEffect.FormKey));
        string CategoryText(IIngestibleGetter r) => string.Join("+", r.Effects.Where(e => hunger.Contains(e.BaseEffect.FormKey))
            .Select(e => category.TryGetValue(e.BaseEffect.FormKey, out var c) ? c : full.TryResolve<IMagicEffectGetter>(e.BaseEffect.FormKey, out var m) ? (m.EditorID ?? "").Substring(prefix.Length) : e.BaseEffect.FormKey.ToString()));

        // A Creation's food whose winner lost its hunger effects gets them back on top of every other change of the winner
        var forwarded = new HashSet<FormKey>();
        foreach (var m in ccMods)
        {
            foreach (var r in m.Ingestibles)
            {
                var effects = r.Effects.Where(e => hunger.Contains(e.BaseEffect.FormKey)).ToList();
                if (effects.Count == 0 || forwarded.Contains(r.FormKey)) continue;
                var ctx = full.ResolveContext<IIngestible, IIngestibleGetter>(r.FormKey);
                if (HasHunger(ctx.Record)) continue;
                var o = ctx.GetOrAddAsOverride(Mod);
                foreach (var e in effects) o.Effects.Add(e.DeepCopy());
                forwarded.Add(r.FormKey);
                foodRows.Add((r.FormKey.ToString(), r.EditorID ?? "", ctx.ModKey.FileName, CategoryText(o), $"forwarded from {m.ModKey.FileName}"));
            }
        }

        // Survival's own category of a model: the first food in load order carrying exactly one hunger effect and that model
        var position = fullOrder.ListedOrder.Select((l, i) => (l.ModKey, i)).ToDictionary(x => x.ModKey, x => x.i);
        var ordered = fullOrder.PriorityOrder.Ingestible().WinningOverrides()
            .OrderBy(w => position.GetValueOrDefault(w.FormKey.ModKey, int.MaxValue)).ThenBy(w => w.FormKey.ID).ToList();
        var templates = new Dictionary<string, (string Category, string EditorId)>(StringComparer.OrdinalIgnoreCase);
        foreach (var w in ordered.Select(w => Mod.Ingestibles.TryGetValue(w.FormKey, out var o) ? o : w))
        {
            var effects = w.Effects.Where(e => hunger.Contains(e.BaseEffect.FormKey)).ToList();
            var model = ModelPath(w);
            if (effects.Count == 1 && category.TryGetValue(effects[0].BaseEffect.FormKey, out var cat) && model != "") templates.TryAdd(model, (cat, w.EditorID ?? ""));
        }

        var surveyed = (fh["surveyedOrigins"]?.AsArray().Select(x => ModKey.FromNameAndExtension(x!.GetValue<string>())) ?? Enumerable.Empty<ModKey>()).ToHashSet();
        var drinks = (fh["drinkSounds"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var bowls = (fh["bowlSounds"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var bowlMin = fh["bowlMinWeight"]!.GetValue<float>();
        var snackMax = fh["snackMaxWeight"]!.GetValue<float>();
        var carried = 0;
        foreach (var w in ordered)
        {
            if (forwarded.Contains(w.FormKey)) continue;
            if (HasHunger(w)) { carried++; continue; }
            if (!w.Flags.HasFlag(Ingestible.Flag.FoodItem)) continue;
            var winner = full.ResolveSimpleContext<IIngestibleGetter>(w.FormKey).ModKey.FileName;
            var skip = w.Flags.HasFlag(Ingestible.Flag.Poison) ? "poison" : surveyed.Contains(w.FormKey.ModKey) ? "Survival left it without hunger" : null;
            if (skip != null)
            {
                foodRows.Add((w.FormKey.ToString(), w.EditorID ?? "", winner, "-", skip));
                continue;
            }
            var sound = full.TryResolve<ISoundDescriptorGetter>(w.ConsumeSound.FormKey, out var snd) ? snd.EditorID ?? "" : "";
            var model = ModelPath(w);
            var (assigned, reason) = drinks.Contains(sound) ? ("VerySmall", $"drink ({sound})")
                : model != "" && templates.TryGetValue(model, out var t) ? (t.Category, $"model of {t.EditorId}")
                : bowls.Contains(sound) && w.Weight >= bowlMin ? ("Large", $"bowl ({sound}, weight {w.Weight:0.##})")
                : w.Weight <= snackMax ? ("Small", $"snack (weight {w.Weight:0.##})")
                : ("Medium", $"meal (weight {w.Weight:0.##})");
            if (!effectOf.TryGetValue(assigned, out var effect)) { Report.Errors.Add($"creations: no food hunger effect for category {assigned}"); continue; }
            var added = full.ResolveContext<IIngestible, IIngestibleGetter>(w.FormKey).GetOrAddAsOverride(Mod);
            added.Effects.Add(new Effect { BaseEffect = effect.ToNullableLink(), Data = new EffectData { Magnitude = 0, Area = 0, Duration = 0 } });
            foodRows.Add((w.FormKey.ToString(), w.EditorID ?? "", winner, assigned, reason));
        }
        var assignedCount = foodRows.Count(r => r.Category != "-" && !r.Reason.StartsWith("forwarded", StringComparison.Ordinal));
        Report.Notes.Add($"food hunger: {carried} winning ingestibles carry a hunger effect, {forwarded.Count} forwarded, {assignedCount} assigned by category, {foodRows.Count(r => r.Category == "-")} foods left without one");
        foreach (var r in foodRows) Report.Notes.Add($"ALCH {r.Key} {r.EditorId} ({r.Winner}): {(r.Category == "-" ? "no hunger" : r.Category)}, {r.Reason}");
    }

    static string ModelPath(IIngestibleGetter r) => r.Model?.File.GivenPath.Replace('/', '\\') ?? "";

    public string FoodTable()
    {
        var md = new System.Text.StringBuilder();
        md.Append("# Food hunger values set by AlduinakCreations.esp\n\n");
        md.Append("Foods whose winning record already carries a Survival hunger effect are not listed; `-` marks a food left without one.\n\n");
        md.Append("| Form key | Editor id | Winner | Category | Reason |\n|---|---|---|---|---|\n");
        foreach (var r in foodRows.OrderBy(r => r.Category == "-").ThenBy(r => r.Winner, StringComparer.OrdinalIgnoreCase).ThenBy(r => r.EditorId, StringComparer.OrdinalIgnoreCase))
            md.Append($"| {r.Key} | {r.EditorId} | {r.Winner} | {r.Category} | {r.Reason} |\n");
        return md.ToString();
    }

    HashSet<string> Codes(string field) =>
        (cs[field]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.Ordinal);

    // ---- the Creation recipes, tiered by the same steps as AlduinakAdditions.esp with the creations lists ------------
    public void Recipes(JsonObject spec, ModKey markerKey)
    {
        var merged = MergedRecipeSpec(spec, cs["recipes"] as JsonObject ?? new JsonObject());
        var ctx = new PatchContext(Mod, full, fullOrder, merged, Report, markerKey, r => cc.Contains(r.FormKey.ModKey));
        try
        {
            Steps.Cooking(ctx);
            Steps.Smithing(ctx);
            Steps.Tempering(ctx);
            Steps.Uncraftable(ctx);
        }
        catch (SpecException e)
        {
            Report.Errors.Add("creations recipes: " + e.Message);
        }
    }

    // The root spec with every recipe list emptied, then the creations lists laid over it; material lists add to the root table
    static JsonObject MergedRecipeSpec(JsonObject spec, JsonObject recipes)
    {
        var merged = spec.DeepClone().AsObject();
        merged.Remove("creations");
        void Set(string section, string field, JsonNode value) { if (merged[section] is JsonObject s) s[field] = value; }
        Set("cooking", "tiers", new JsonObject());
        Set("cooking", "needsSalt", new JsonArray());
        Set("cooking", "stripConditions", true);
        Set("smithing", "tiers", new JsonObject());
        Set("smithing", "addItems", new JsonObject());
        Set("smithing", "exclude", new JsonArray());
        Set("smithing", "newRecipes", new JsonArray());
        Set("tailoring", "recipes", new JsonArray());
        Set("tailoring", "newRecipes", new JsonArray());
        (merged["tailoring"] as JsonObject)?.Remove("disableRecipes");
        Set("uncraftable", "recipes", new JsonArray());
        foreach (var (section, body) in recipes)
        {
            if (merged[section] is not JsonObject target) throw new SpecException($"creations.recipes.{section} has no matching section in the spec");
            foreach (var (field, value) in body!.AsObject())
            {
                if (field == "materials" && target["materials"] is JsonObject table)
                {
                    foreach (var (rank, list) in value!.AsObject())
                    {
                        if (table[rank] is not JsonArray existing) table[rank] = existing = new JsonArray();
                        foreach (var x in list!.AsArray()) existing.Add(x!.DeepClone());
                    }
                }
                else target[field] = value!.DeepClone();
            }
        }
        return merged;
    }

    // ---- cells and worldspaces carry the fields of their baseline winner, so no city mod edit is undone ---------------
    public void CellFields()
    {
        foreach (var fk in editedContainers)
        {
            if (full.TryResolveContext<ICell, ICellGetter>(fk, out _)) { if (!HasCell(fk)) baseline.ResolveContext<ICell, ICellGetter>(fk).GetOrAddAsOverride(Mod); }
            else if (full.TryResolveContext<IWorldspace, IWorldspaceGetter>(fk, out _)) { if (!Mod.Worldspaces.ContainsKey(fk)) baseline.ResolveContext<IWorldspace, IWorldspaceGetter>(fk).GetOrAddAsOverride(Mod); }
            else Report.Errors.Add($"creations: edited container {fk} is neither a cell nor a worldspace");
        }
        var cellMask = new Cell.TranslationMask(defaultOn: true)
        {
            Persistent = false, Temporary = false, NavigationMeshes = false, Landscape = false,
            Timestamp = false, UnknownGroupData = false, PersistentTimestamp = false, PersistentUnknownGroupData = false,
            TemporaryTimestamp = false, TemporaryUnknownGroupData = false,
        };
        int cells = 0, worlds = 0;
        foreach (var c in AllCells())
        {
            var src = baseline.TryResolve<ICellGetter>(c.FormKey, out var b) ? b : full.Resolve<ICellGetter>(c.FormKey);
            c.DeepCopyIn(src, cellMask);
            cells++;
        }
        var worldMask = new Worldspace.TranslationMask(defaultOn: true) { TopCell = false, SubCells = false, SubCellsTimestamp = false, SubCellsUnknown = false };
        foreach (var w in Mod.Worldspaces)
        {
            var src = baseline.TryResolve<IWorldspaceGetter>(w.FormKey, out var b) ? b : full.Resolve<IWorldspaceGetter>(w.FormKey);
            w.DeepCopyIn(src, worldMask);
            worlds++;
        }
        Report.Notes.Add($"container fields: {cells} cells and {worlds} worldspaces carry their winner without the Creations ({editedContainers.Count} were edited by a Creation)");
    }

    bool HasCell(FormKey fk) => AllCells().Any(c => c.FormKey == fk);

    IEnumerable<Cell> AllCells()
    {
        foreach (var b in Mod.Cells.Records) foreach (var sb in b.SubBlocks) foreach (var c in sb.Cells) yield return c;
        foreach (var w in Mod.Worldspaces)
        {
            if (w.TopCell != null) yield return w.TopCell;
            foreach (var b in w.SubCells) foreach (var sb in b.Items) foreach (var c in sb.Items) yield return c;
        }
    }

    // ESL-flagged plugins may hold overrides only: no record may be the plugin's own
    public void CheckOverridesOnly()
    {
        var own = Mod.EnumerateMajorRecords().Where(r => r.FormKey.ModKey == Mod.ModKey).Select(r => r.FormKey.ToString()).Take(10).ToList();
        if (own.Count > 0) Report.Errors.Add($"creations: new records in an overrides-only plugin: {string.Join(", ", own)}");
    }
}
