using System.Text.Json;
using System.Text.Json.Nodes;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Environments;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Aspects;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Order;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;
using Noggog;

// Rewrites AlduinakAdditions.esp with the proficiency content described by spec.json: the rank marker abilities,
// the crafting keywords, the alchemy lab and woodcrafting benches, the potion and charcoal recipes, and the tier
// conditions on cooking, smithing, woodworking and tailoring recipes.
// Run through patch.py, which pre-cleans the plugin, invokes this program and verifies the result.
//   dotnet run -c Release -- --settings <server-settings.json> --plugin <precleaned AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>]

var opts = Cli.Parse(args);
var spec = JsonNode.Parse(File.ReadAllText(opts.Spec))!.AsObject();
var settings = JsonNode.Parse(File.ReadAllText(opts.Settings))!;
var dataDir = settings["dataDir"]!.GetValue<string>();
var loadOrderNames = settings["loadOrder"]!.AsArray().Select(n => Path.GetFileName(n!.GetValue<string>())).ToList();
var pluginName = spec["pluginName"]?.GetValue<string>() ?? "AlduinakAdditions.esp";
var pluginKey = ModKey.FromNameAndExtension(pluginName);
var position = loadOrderNames.FindIndex(n => string.Equals(n, pluginName, StringComparison.OrdinalIgnoreCase));
if (position < 0) throw new Exception($"{pluginName} is not in the server load order");

var keys = loadOrderNames.Select(n => ModKey.FromNameAndExtension(n)).ToArray();
var env = GameEnvironment.Typical.Builder<ISkyrimMod, ISkyrimModGetter>(GameRelease.SkyrimSE)
    .WithTargetDataFolder(dataDir)
    .WithLoadOrder(keys)
    .Build();
var cache = env.LinkCache;
// The pre-cleaned copy has another file name, the records must still belong to the plugin's own key
var mod = SkyrimMod.CreateFromBinary(new ModPath(pluginKey, opts.Plugin), SkyrimRelease.SkyrimSE);
// Light (ESL-flagged) plugins share the 0xFE slot, so the plugin's full slot counts only the full plugins before it
var loadIndex = env.LoadOrder.ListedOrder.Take(position).Count(l => l.Mod != null && ((int)l.Mod.ModHeader.Flags & 0x200) == 0);
if (((int)mod.ModHeader.Flags & 0x200) != 0) throw new Exception($"{pluginName} is ESL-flagged, the global id rule below does not apply");
var report = new Report(loadIndex, pluginKey);
var ctx = new PatchContext(mod, cache, env.LoadOrder, spec, report);
if (opts.NextFormId is uint pinned)
{
    // Pinned ids keep the marker spells stable for learnedSpells and server-settings.json; AddNew does not check for collisions
    var taken = mod.EnumerateMajorRecords().Where(r => r.FormKey.ModKey == pluginKey && r.FormKey.ID >= pinned && r.FormKey.ID < pinned + 0x100).Select(r => r.FormKey.ToString()).ToList();
    if (taken.Count > 0) throw new Exception($"--next-form-id {pinned:X}: own records already use {string.Join(", ", taken.Take(10))}");
    mod.ModHeader.Stats.NextFormID = pinned;
}

Console.WriteLine($"{pluginName}: position {position} in the load order, full slot {loadIndex:X2}, {mod.ModHeader.MasterReferences.Count} masters, next form id {mod.ModHeader.Stats.NextFormID:X}");

Steps.Keywords(ctx);
Steps.MarkerAbilities(ctx);
Steps.WoodcraftingBench(ctx);
Steps.AlchemyLabs(ctx);
Steps.AlchemyRecipes(ctx);
Steps.KilnRecipes(ctx);
Steps.Cooking(ctx);
Steps.Smithing(ctx);
Steps.Woodworking(ctx);
Steps.Tailoring(ctx);

if (report.Errors.Count > 0)
{
    Console.WriteLine($"{report.Errors.Count} error(s):");
    foreach (var e in report.Errors) Console.WriteLine("  " + e);
    report.Write(opts.ReportDir, mod, env.LoadOrder, failed: true);
    return 2;
}

Directory.CreateDirectory(opts.Out);
var outPath = Path.Combine(opts.Out, pluginName);
mod.WriteToBinary(outPath, new BinaryWriteParameters
{
    MastersListContent = MastersListContentOption.Iterate,
    MastersListOrdering = new MastersListOrderingByLoadOrder(env.LoadOrder.ListedOrder.Select(l => l.ModKey)),
    ModKey = ModKeyOption.NoCheck,
    RecordCount = RecordCountOption.Iterate,
    NextFormID = NextFormIDOption.Iterate,
});
Console.WriteLine($"wrote {outPath} ({new FileInfo(outPath).Length} bytes)");
report.Write(opts.ReportDir, mod, env.LoadOrder, failed: false);
return 0;

// ---------------------------------------------------------------------------------------------------------------------

record Cli(string Settings, string Plugin, string Spec, string Out, string ReportDir, uint? NextFormId)
{
    public static Cli Parse(string[] args)
    {
        string? settings = null, plugin = null, spec = null, outDir = null, reportDir = null;
        uint? nextFormId = null;
        for (int i = 0; i + 1 < args.Length; i += 2)
        {
            switch (args[i])
            {
                case "--settings": settings = args[i + 1]; break;
                case "--plugin": plugin = args[i + 1]; break;
                case "--spec": spec = args[i + 1]; break;
                case "--out": outDir = args[i + 1]; break;
                case "--report": reportDir = args[i + 1]; break;
                case "--next-form-id": nextFormId = Convert.ToUInt32(args[i + 1], 16); break;
                default: throw new Exception($"unknown option {args[i]}");
            }
        }
        if (settings == null || plugin == null || spec == null || outDir == null)
            throw new Exception("usage: --settings <server-settings.json> --plugin <AlduinakAdditions.esp> --spec <spec.json> --out <dir> [--report <dir>] [--next-form-id <hex>]");
        return new Cli(settings, plugin, spec, outDir, reportDir ?? outDir, nextFormId);
    }
}

class PatchContext
{
    public readonly SkyrimMod Mod;
    public readonly ILinkCache Cache;
    public readonly ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> LoadOrder;
    public readonly JsonObject Spec;
    public readonly Report Report;
    public readonly ModKey Key;
    // Editor id -> record already in the mutable plugin (own records and overrides), refreshed as records are added.
    private readonly Dictionary<string, IMajorRecord> ownByEdid = new(StringComparer.OrdinalIgnoreCase);

    public PatchContext(SkyrimMod mod, ILinkCache cache, ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> loadOrder, JsonObject spec, Report report)
    {
        Mod = mod; Cache = cache; LoadOrder = loadOrder; Spec = spec; Report = report; Key = mod.ModKey;
        foreach (var rec in mod.EnumerateMajorRecords())
            if (!string.IsNullOrEmpty(rec.EditorID)) ownByEdid[rec.EditorID] = rec;
    }

    public string[] Ranks => Spec["ranks"]!.AsArray().Select(r => r!.GetValue<string>()).ToArray();
    public IEnumerable<KeyValuePair<string, string>> Professions => Spec["professions"]!.AsObject().Select(p => new KeyValuePair<string, string>(p.Key, p.Value!.GetValue<string>()));

    public string MarkerEdid(string profession, string rank) => $"AldMastery_{Cap(profession)}_{rank}";
    public static string Cap(string s) => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);

    // Winning record of the load order by editor id, of a given type.
    public bool TryWinning<T>(string edid, out T rec) where T : class, IMajorRecordGetter
    {
        if (ownByEdid.TryGetValue(edid, out var own) && own is T ownT) { rec = ownT; return true; }
        if (Cache.TryResolve<T>(edid, out var found)) { rec = found; return true; }
        rec = null!;
        return false;
    }

    public T Winning<T>(string edid) where T : class, IMajorRecordGetter
    {
        if (TryWinning<T>(edid, out var rec)) return rec;
        throw new SpecException($"{typeof(T).Name} '{edid}' not found in the load order");
    }

    public FormKey KeyOf<T>(string edid) where T : class, IMajorRecordGetter => Winning<T>(edid).FormKey;

    // Own record by editor id, created when missing (idempotent re-runs reuse it).
    public T OwnOrNew<T>(IGroup<T> group, string edid, Action<T>? init = null) where T : class, IMajorRecord
    {
        if (ownByEdid.TryGetValue(edid, out var existing))
        {
            if (existing is T t && t.FormKey.ModKey == Key) return t;
            throw new SpecException($"'{edid}' already exists in {Key} as {existing.GetType().Name}, not as a new {typeof(T).Name}");
        }
        if (Cache.TryResolveIdentifier(edid, out var clash) && clash.ModKey != Key)
            throw new SpecException($"editor id '{edid}' is already used by {clash}");
        var rec = group.AddNew(edid);
        init?.Invoke(rec);
        ownByEdid[edid] = rec;
        Report.NewRecords.Add($"{rec.Registration.Name} {edid} {rec.FormKey}");
        return rec;
    }

    // Override of a winning record, added to the plugin when it is not already overridden there.
    public T Override<T, TGetter>(IGroup<T> group, TGetter winning) where T : class, IMajorRecordInternal, TGetter where TGetter : class, IMajorRecordGetter
    {
        var rec = group.GetOrAddAsOverride(winning);
        if (!string.IsNullOrEmpty(rec.EditorID)) ownByEdid[rec.EditorID] = rec;
        return rec;
    }

    public void Error(string msg) => Report.Errors.Add(msg);
    public void Note(string msg) => Report.Notes.Add(msg);
    public void Warn(string msg) => Report.Warnings.Add(msg);
}

class SpecException : Exception { public SpecException(string m) : base(m) { } }

static class Steps
{
    // ---- keywords ----------------------------------------------------------------------------------------------
    public static void Keywords(PatchContext c)
    {
        foreach (var kv in c.Spec["keywords"]!.AsObject())
            c.OwnOrNew(c.Mod.Keywords, kv.Value!.GetValue<string>());
    }

    // ---- marker abilities: one Ability spell per profession and rank, carrying that rank's vanilla perks ---------
    public static void MarkerAbilities(PatchContext c)
    {
        var abilities = c.Spec["abilities"]?.AsObject();
        foreach (var (profId, label) in c.Professions)
        {
            foreach (var rank in c.Ranks)
            {
                var edid = c.MarkerEdid(profId, rank);
                var spell = c.OwnOrNew(c.Mod.Spells, edid);
                spell.Name = $"{label}: {rank}";
                spell.Type = SpellType.Ability;
                spell.CastType = CastType.ConstantEffect;
                spell.TargetType = TargetType.Self;
                spell.CastDuration = 0;
                spell.ChargeTime = 0;
                spell.BaseCost = 0;
                spell.Flags = SpellDataFlag.ManualCostCalc;
                spell.EquipmentType.Clear();
                spell.Effects.Clear();
                spell.Description = $"Rank of {rank} in the craft of the {label}.";

                var rankSpec = abilities?[profId]?[rank]?.AsObject();
                if (rankSpec == null) continue;
                // "perks": ["QuickShot", {"edid": "DualFlurry30", "untilRank": "Master"}]; a perk with untilRank switches off once that rank's marker is held
                foreach (var entry in rankSpec["perks"]?.AsArray() ?? new JsonArray())
                {
                    var perkEdid = entry is JsonObject po ? po["edid"]!.GetValue<string>() : entry!.GetValue<string>();
                    var untilRank = entry is JsonObject po2 ? po2["untilRank"]?.GetValue<string>() : null;
                    if (!c.TryWinning<IPerkGetter>(perkEdid, out var perk)) { c.Error($"perk '{perkEdid}' for {edid} not found"); continue; }
                    var mgef = c.OwnOrNew(c.Mod.MagicEffects, $"AldMasteryPerk_{perkEdid}");
                    ConfigureMgef(mgef, $"{perk.Name?.String ?? perkEdid}", perk.Description?.String ?? "");
                    mgef.Archetype = new MagicEffectArchetype { Type = MagicEffectArchetype.TypeEnum.Script, ActorValue = ActorValue.None };
                    mgef.PerkToApply.SetTo(perk.FormKey);
                    var effect = new Effect { BaseEffect = mgef.ToNullableLink(), Data = new EffectData { Magnitude = 0, Area = 0, Duration = 0 } };
                    if (untilRank != null)
                    {
                        if (Array.IndexOf(c.Ranks, untilRank) < 0) { c.Error($"{edid}: unknown untilRank '{untilRank}'"); continue; }
                        var higher = c.OwnOrNew(c.Mod.Spells, c.MarkerEdid(profId, untilRank));
                        var data = new HasSpellConditionData { RunOnType = Condition.RunOnType.Subject };
                        data.Spell.Link.SetTo(higher.FormKey);
                        effect.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 0f, Data = data });
                    }
                    spell.Effects.Add(effect);
                }
                var stamina = rankSpec["stamina"]?.GetValue<float>() ?? 0;
                if (stamina > 0)
                {
                    var mgef = c.OwnOrNew(c.Mod.MagicEffects, "AldMasteryFortifyStamina");
                    ConfigureMgef(mgef, "Fortify Stamina", "Stamina is increased by <mag> points.");
                    mgef.Archetype = new MagicEffectArchetype { Type = MagicEffectArchetype.TypeEnum.ValueModifier, ActorValue = ActorValue.Stamina };
                    mgef.Flags = (mgef.Flags & ~MagicEffect.Flag.NoMagnitude) | MagicEffect.Flag.Recover;
                    mgef.PerkToApply.SetToNull();
                    spell.Effects.Add(new Effect { BaseEffect = mgef.ToNullableLink(), Data = new EffectData { Magnitude = stamina, Area = 0, Duration = 0 } });
                }
            }
        }
    }

    static void ConfigureMgef(MagicEffect mgef, string name, string description)
    {
        mgef.Name = name;
        mgef.Description = description;
        mgef.CastType = CastType.ConstantEffect;
        mgef.TargetType = TargetType.Self;
        mgef.MagicSkill = ActorValue.None;
        mgef.ResistValue = ActorValue.None;
        mgef.MinimumSkillLevel = 0;
        mgef.BaseCost = 0;
        mgef.Flags = MagicEffect.Flag.HideInUI | MagicEffect.Flag.NoHitEvent | MagicEffect.Flag.NoDuration | MagicEffect.Flag.NoArea | MagicEffect.Flag.NoMagnitude;
        mgef.Conditions.Clear();
    }

    // ---- woodcrafting bench: a new bench from the Hearthfire carpenter's workbench, and the existing ones tagged ---
    public static void WoodcraftingBench(PatchContext c)
    {
        var w = c.Spec["woodcraftingBench"]!.AsObject();
        var kw = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["woodcrafting"]!.GetValue<string>());
        var template = c.Winning<IFurnitureGetter>(w["template"]!.GetValue<string>());
        var edid = w["edid"]!.GetValue<string>();
        var bench = c.OwnOrNew(c.Mod.Furniture, edid);
        var key = bench.FormKey;
        bench.DeepCopyIn(template);
        bench.EditorID = edid;
        // The Hearthfire bench script builds house parts; a plain crafting bench needs none of it
        bench.VirtualMachineAdapter = null;
        bench.Name = w["name"]!.GetValue<string>();
        bench.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
        var drop = (w["removeKeywords"]?.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())) ?? Enumerable.Empty<FormKey>()).ToHashSet();
        bench.Keywords.RemoveAll(x => drop.Contains(x.FormKey));
        if (!bench.Keywords.Any(x => x.FormKey == kw)) bench.Keywords.Add(kw.ToLink<IKeywordGetter>());
        bench.WorkbenchData ??= new WorkbenchData();
        bench.WorkbenchData.BenchType = WorkbenchData.Type.CreateObject;
        bench.WorkbenchData.UsesSkill = null;
        if (bench.FormKey != key) throw new Exception("form key changed by DeepCopyIn");
        c.Note($"Woodcrafting bench {edid} {key} created from {template.EditorID}");

        foreach (var tagEdid in w["alsoTag"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>())
        {
            if (!c.TryWinning<IFurnitureGetter>(tagEdid, out var winning)) { c.Warn($"woodcrafting: bench '{tagEdid}' not found, skipped"); continue; }
            var furn = c.Override(c.Mod.Furniture, winning);
            furn.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
            if (!furn.Keywords.Any(x => x.FormKey == kw)) furn.Keywords.Add(kw.ToLink<IKeywordGetter>());
            c.Note($"Woodcrafting: {tagEdid} also offers woodcrafting recipes");
        }
    }

    // ---- alchemy labs open the crafting menu instead of the alchemy menu -------------------------------------------
    public static void AlchemyLabs(PatchContext c)
    {
        var kw = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["alchemy"]!.GetValue<string>());
        foreach (var edid in c.Spec["alchemyLabs"]!.AsArray().Select(x => x!.GetValue<string>()))
        {
            if (!c.TryWinning<IFurnitureGetter>(edid, out var winning)) { c.Warn($"alchemy lab '{edid}' not found, skipped"); continue; }
            var furn = c.Override(c.Mod.Furniture, winning);
            furn.WorkbenchData ??= new WorkbenchData();
            furn.WorkbenchData.BenchType = WorkbenchData.Type.CreateObject;
            furn.WorkbenchData.UsesSkill = null;
            furn.Keywords ??= new ExtendedList<IFormLinkGetter<IKeywordGetter>>();
            if (!furn.Keywords.Any(x => x.FormKey == kw)) furn.Keywords.Add(kw.ToLink<IKeywordGetter>());
            c.Note($"Alchemy lab {edid}: crafting menu with keyword {c.EdidOf(kw)}");
        }
    }

    // ---- potion, drink, poison and salt recipes at the alchemy lab ---------------------------------------------------
    public static void AlchemyRecipes(PatchContext c)
    {
        var bench = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["alchemy"]!.GetValue<string>());
        var profession = c.Spec["alchemy"]!["profession"]!.GetValue<string>();
        foreach (var r in c.Spec["alchemy"]!["recipes"]!.AsArray().Select(x => x!.AsObject()))
            NewRecipe(c, r, bench, profession, "AldRecipeAlchemy_");
    }

    public static void KilnRecipes(PatchContext c)
    {
        var bench = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["kiln"]!.GetValue<string>());
        foreach (var r in c.Spec["kilnRecipes"]!.AsArray().Select(x => x!.AsObject()))
            NewRecipe(c, r, bench, r["profession"]!.GetValue<string>(), "AldRecipeKiln_");
    }

    static void NewRecipe(PatchContext c, JsonObject r, FormKey bench, string profession, string prefix)
    {
        var outputEdid = r["output"]!.GetValue<string>();
        if (!c.TryWinning<IMajorRecordGetter>(outputEdid, out var output)) { c.Error($"recipe output '{outputEdid}' not found"); return; }
        var edid = r["edid"]?.GetValue<string>() ?? prefix + outputEdid;
        var cobj = c.OwnOrNew(c.Mod.ConstructibleObjects, edid);
        cobj.WorkbenchKeyword.SetTo(bench);
        cobj.CreatedObject.SetTo(output.FormKey);
        cobj.CreatedObjectCount = (ushort)(r["count"]?.GetValue<int>() ?? 1);
        cobj.Items = new ExtendedList<ContainerEntry>();
        foreach (var item in r["items"]!.AsObject())
        {
            if (!c.TryWinning<IMajorRecordGetter>(item.Key, out var ing)) { c.Error($"recipe {edid}: ingredient '{item.Key}' not found"); continue; }
            cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = ing.FormKey.ToLink<IItemGetter>(), Count = item.Value!.GetValue<int>() } });
        }
        SetTier(c, cobj, profession, r["tier"]!.GetValue<string>());
        c.Report.Recipes.Add(new RecipeLine(Kind(prefix), edid, c.NameOf(output.FormKey), profession, r["tier"]!.GetValue<string>(), cobj.Items.Select(i => $"{i.Item.Count}x {c.NameOf(i.Item.Item.FormKey)}").ToList()));
    }

    static string Kind(string prefix) => prefix.Contains("Kiln") ? "kiln" : "alchemy";

    // ---- cooking: vanilla recipes kept, meats need salt, tiers by the owner's list ----------------------------------
    public static void Cooking(PatchContext c)
    {
        var cook = c.Spec["cooking"]!.AsObject();
        var profession = cook["profession"]!.GetValue<string>();
        var salt = c.KeyOf<IMajorRecordGetter>(cook["saltItem"]!.GetValue<string>());
        var needsSalt = cook["needsSalt"]!.AsArray().Select(x => x!.GetValue<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var tierOf = TierMap(cook["tiers"]!.AsObject());
        var benches = cook["benches"]!.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())).ToHashSet();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey)) continue;
            var edid = winning.EditorID ?? "";
            seen.Add(edid);
            var tier = tierOf.GetValueOrDefault(edid, "Novice");
            var addSalt = needsSalt.Contains(edid) && !(winning.Items ?? new List<IContainerEntryGetter>()).Any(i => i.Item.Item.FormKey == salt);
            if (tier == "Novice" && !addSalt && !HasAldCondition(c, winning)) { c.Report.Recipes.Add(new RecipeLine("cooking", edid, c.NameOf(winning.CreatedObject.FormKey), profession, "Novice", Items(c, winning), untouched: true)); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            cobj.Items ??= new ExtendedList<ContainerEntry>();
            if (addSalt) cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = salt.ToLink<IItemGetter>(), Count = 1 } });
            SetTier(c, cobj, profession, tier);
            c.Report.Recipes.Add(new RecipeLine("cooking", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), salted: addSalt));
        }
        foreach (var edid in tierOf.Keys.Concat(needsSalt).Where(e => !seen.Contains(e)))
            c.Error($"cooking: recipe '{edid}' is not a winning cooking recipe in the load order");
    }

    // ---- smithing: tier by the highest material used; vanilla perk gates removed ----------------------------------
    public static void Smithing(PatchContext c)
    {
        var s = c.Spec["smithing"]!.AsObject();
        var profession = s["profession"]!.GetValue<string>();
        var benches = s["benches"]!.AsArray().Select(x => c.KeyOf<IKeywordGetter>(x!.GetValue<string>())).ToHashSet();
        var exclude = (s["exclude"]?.AsArray().Select(x => x!.GetValue<string>()) ?? Enumerable.Empty<string>()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var forced = TierMap(s["tiers"]?.AsObject() ?? new JsonObject());
        var ranks = c.Ranks;
        var materialTier = new Dictionary<FormKey, int>();
        foreach (var (rank, list) in s["materials"]!.AsObject().Select(kv => (kv.Key, kv.Value!.AsArray())))
        {
            var idx = Array.IndexOf(ranks, rank);
            if (idx < 0) throw new SpecException($"smithing material rank '{rank}' unknown");
            foreach (var edid in list.Select(x => x!.GetValue<string>()))
            {
                if (!c.TryWinning<IMajorRecordGetter>(edid, out var mat)) { c.Error($"smithing material '{edid}' not found"); continue; }
                materialTier[mat.FormKey] = Math.Max(materialTier.GetValueOrDefault(mat.FormKey), idx);
            }
        }
        var woodworking = WoodworkingSet(c);
        var stripPerks = s["stripPerkConditions"]?.GetValue<bool>() ?? true;
        foreach (var winning in c.LoadOrder.PriorityOrder.ConstructibleObject().WinningOverrides())
        {
            if (!benches.Contains(winning.WorkbenchKeyword.FormKey)) continue;
            var edid = winning.EditorID ?? "";
            if (exclude.Contains(edid) || woodworking.Contains(edid)) continue;
            // The highest material among the inputs and the product decides the tier
            int tierIdx = materialTier.GetValueOrDefault(winning.CreatedObject.FormKey);
            foreach (var item in winning.Items ?? new List<IContainerEntryGetter>())
                tierIdx = Math.Max(tierIdx, materialTier.GetValueOrDefault(item.Item.Item.FormKey));
            if (forced.TryGetValue(edid, out var forcedTier)) tierIdx = Array.IndexOf(ranks, forcedTier);
            var tier = ranks[tierIdx];
            var hasPerk = winning.Conditions.Any(IsPerkCondition);
            if (tier == "Novice" && !(stripPerks && hasPerk) && !HasAldCondition(c, winning))
            {
                c.Report.Recipes.Add(new RecipeLine("smithing", edid, c.NameOf(winning.CreatedObject.FormKey), profession, tier, Items(c, winning), untouched: true, origin: winning.FormKey.ModKey.FileName));
                continue;
            }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            if (stripPerks) cobj.Conditions.RemoveAll(IsPerkCondition);
            SetTier(c, cobj, profession, tier);
            c.Report.Recipes.Add(new RecipeLine("smithing", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), perkStripped: hasPerk, origin: winning.FormKey.ModKey.FileName));
        }
    }

    static HashSet<string> WoodworkingSet(PatchContext c)
    {
        var w = c.Spec["woodworking"]!["recipes"]!.AsObject();
        return w.SelectMany(kv => kv.Value!.AsArray().Select(x => x!.GetValue<string>())).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    // ---- woodworking: bows, arrows and shields move to the woodcrafting bench --------------------------------------
    public static void Woodworking(PatchContext c)
    {
        var w = c.Spec["woodworking"]!.AsObject();
        var profession = w["profession"]!.GetValue<string>();
        var bench = c.KeyOf<IKeywordGetter>(c.Spec["keywords"]!["woodcrafting"]!.GetValue<string>());
        var stripPerks = w["stripPerkConditions"]?.GetValue<bool>() ?? true;
        foreach (var (tier, list) in w["recipes"]!.AsObject().Select(kv => (kv.Key, kv.Value!.AsArray())))
        {
            foreach (var edid in list.Select(x => x!.GetValue<string>()))
            {
                if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"woodworking recipe '{edid}' not found"); continue; }
                var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
                var from = c.EdidOf(cobj.WorkbenchKeyword.FormKey);
                cobj.WorkbenchKeyword.SetTo(bench);
                var hasPerk = cobj.Conditions.Any(IsPerkCondition);
                if (stripPerks) cobj.Conditions.RemoveAll(IsPerkCondition);
                SetTier(c, cobj, profession, tier);
                c.Report.Recipes.Add(new RecipeLine("woodworking", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), perkStripped: hasPerk, origin: winning.FormKey.ModKey.FileName, note: $"moved from {from}"));
            }
        }
    }

    // ---- tailoring: the owner's list, with ingredient corrections and three new recipes -----------------------------
    public static void Tailoring(PatchContext c)
    {
        var t = c.Spec["tailoring"]!.AsObject();
        var profession = t["profession"]!.GetValue<string>();
        foreach (var r in t["recipes"]!.AsArray().Select(x => x!.AsObject()))
        {
            var edid = r["edid"]!.GetValue<string>();
            if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"tailoring recipe '{edid}' not found"); continue; }
            var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
            if (r["bench"] != null) cobj.WorkbenchKeyword.SetTo(c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>()));
            if (r["items"] != null)
            {
                cobj.Items = new ExtendedList<ContainerEntry>();
                foreach (var item in r["items"]!.AsObject())
                {
                    if (!c.TryWinning<IMajorRecordGetter>(item.Key, out var ing)) { c.Error($"tailoring recipe {edid}: ingredient '{item.Key}' not found"); continue; }
                    cobj.Items.Add(new ContainerEntry { Item = new ContainerItem { Item = ing.FormKey.ToLink<IItemGetter>(), Count = item.Value!.GetValue<int>() } });
                }
            }
            var hasPerk = cobj.Conditions.Any(IsPerkCondition);
            cobj.Conditions.RemoveAll(IsPerkCondition);
            var tier = r["tier"]!.GetValue<string>();
            SetTier(c, cobj, profession, tier);
            c.Report.Recipes.Add(new RecipeLine("tailoring", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, tier, Items(c, cobj), perkStripped: hasPerk, origin: winning.FormKey.ModKey.FileName));
        }
        foreach (var r in t["newRecipes"]?.AsArray().Select(x => x!.AsObject()) ?? Enumerable.Empty<JsonObject>())
        {
            var bench = c.KeyOf<IKeywordGetter>(r["bench"]!.GetValue<string>());
            NewRecipe(c, r, bench, profession, "AldRecipeTailor_");
        }
        if (t["disableRecipes"] is JsonArray disable)
        {
            var parking = c.KeyOf<IKeywordGetter>(t["disabledBench"]!.GetValue<string>());
            foreach (var edid in disable.Select(x => x!.GetValue<string>()))
            {
                if (!c.TryWinning<IConstructibleObjectGetter>(edid, out var winning)) { c.Error($"tailoring: recipe to disable '{edid}' not found"); continue; }
                var cobj = c.Override(c.Mod.ConstructibleObjects, winning);
                cobj.WorkbenchKeyword.SetTo(parking);
                c.Report.Recipes.Add(new RecipeLine("tailoring", edid, c.NameOf(cobj.CreatedObject.FormKey), profession, "disabled", Items(c, cobj), origin: winning.FormKey.ModKey.FileName, note: "bench set to the parking keyword, recipe hidden"));
            }
        }
    }

    // ---- helpers -------------------------------------------------------------------------------------------------
    static Dictionary<string, string> TierMap(JsonObject tiers)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (tier, list) in tiers.Select(kv => (kv.Key, kv.Value!.AsArray())))
            foreach (var edid in list.Select(x => x!.GetValue<string>()))
            {
                if (map.TryGetValue(edid, out var other) && other != tier) throw new SpecException($"recipe '{edid}' is listed under both {other} and {tier}");
                map[edid] = tier;
            }
        return map;
    }

    static bool IsPerkCondition(IConditionGetter cond) => cond.Data is IHasPerkConditionDataGetter;

    static bool HasAldCondition(PatchContext c, IConstructibleObjectGetter cobj) =>
        cobj.Conditions.Any(cond => cond.Data is IHasSpellConditionDataGetter hs && hs.Spell.Link.FormKey.ModKey == c.Key);

    // Replace every existing marker condition by the one for this tier; Novice means no condition at all.
    static void SetTier(PatchContext c, ConstructibleObject cobj, string profession, string tier)
    {
        if (Array.IndexOf(c.Ranks, tier) < 0) throw new SpecException($"unknown tier '{tier}' on {cobj.EditorID}");
        cobj.Conditions.RemoveAll(cond => cond.Data is IHasSpellConditionDataGetter hs && hs.Spell.Link.FormKey.ModKey == c.Key);
        if (tier == c.Ranks[0]) return;
        var marker = c.Winning<ISpellGetter>(c.MarkerEdid(profession, tier));
        var data = new HasSpellConditionData { RunOnType = Condition.RunOnType.Subject };
        data.Spell.Link.SetTo(marker.FormKey);
        cobj.Conditions.Add(new ConditionFloat { CompareOperator = CompareOperator.EqualTo, ComparisonValue = 1f, Data = data });
    }

    static List<string> Items(PatchContext c, IConstructibleObjectGetter cobj) =>
        (cobj.Items ?? new List<IContainerEntryGetter>()).Select(i => $"{i.Item.Count}x {c.NameOf(i.Item.Item.FormKey)}").ToList();
}

static class ContextExtensions
{
    public static string EdidOf(this PatchContext c, FormKey key) => c.Cache.TryResolveIdentifier(key, out var edid) && edid != null ? edid : key.ToString();
    public static string NameOf(this PatchContext c, FormKey key)
    {
        if (c.Cache.TryResolve<INamedGetter>(key, out var named) && !string.IsNullOrEmpty(named.Name)) return named.Name!;
        return c.EdidOf(key);
    }
}

record RecipeLine(string Kind, string Edid, string Output, string Profession, string Tier, List<string> Items, bool untouched = false, bool salted = false, bool perkStripped = false, string? origin = null, string? note = null);

class Report
{
    public readonly List<string> Errors = new();
    public readonly List<string> Warnings = new();
    public readonly List<string> Notes = new();
    public readonly List<string> NewRecords = new();
    public readonly List<RecipeLine> Recipes = new();
    readonly int loadIndex;
    readonly ModKey key;
    public Report(int loadIndex, ModKey key) { this.loadIndex = loadIndex; this.key = key; }

    public uint GlobalId(FormKey k) => (uint)(loadIndex << 24) | k.ID;

    public void Write(string dir, SkyrimMod mod, ILoadOrderGetter<IModListingGetter<ISkyrimModGetter>> loadOrder, bool failed)
    {
        Directory.CreateDirectory(dir);
        var md = new List<string>();
        md.Add($"# Proficiency patch report{(failed ? " (FAILED)" : "")}");
        md.Add("");
        if (Errors.Count > 0) { md.Add("## Errors"); md.AddRange(Errors.Select(e => "- " + e)); md.Add(""); }
        if (Warnings.Count > 0) { md.Add("## Warnings"); md.AddRange(Warnings.Select(e => "- " + e)); md.Add(""); }
        md.Add("## Masters");
        md.AddRange(mod.ModHeader.MasterReferences.Select((m, i) => $"- {i:X2} {m.Master.FileName}"));
        md.Add("");
        md.Add("## Marker spells (global form ids for the server)");
        var spells = new JsonObject();
        foreach (var s in mod.Spells.Where(s => s.FormKey.ModKey == key && (s.EditorID ?? "").StartsWith("AldMastery_")))
        {
            md.Add($"- {s.EditorID}: {s.FormKey} global 0x{GlobalId(s.FormKey):X8} '{s.Name?.String}' effects={s.Effects.Count}");
            spells[s.EditorID!] = $"0x{GlobalId(s.FormKey):X8}";
        }
        md.Add("");
        md.Add("## New records");
        md.AddRange(NewRecords.Select(n => "- " + n));
        md.Add("");
        md.Add("## Notes");
        md.AddRange(Notes.Select(n => "- " + n));
        md.Add("");
        foreach (var group in Recipes.GroupBy(r => r.Kind))
        {
            md.Add($"## Recipes: {group.Key} ({group.Count()})");
            md.Add("");
            md.Add("| tier | recipe | output | origin | items | flags |");
            md.Add("|---|---|---|---|---|---|");
            foreach (var r in group.OrderBy(r => Array.IndexOf(new[] { "Novice", "Adept", "Expert", "Master", "disabled" }, r.Tier)).ThenBy(r => r.Output))
            {
                var flags = new List<string>();
                if (r.untouched) flags.Add("untouched");
                if (r.salted) flags.Add("salt added");
                if (r.perkStripped) flags.Add("perk gate removed");
                if (r.note != null) flags.Add(r.note);
                md.Add($"| {r.Tier} | {r.Edid} | {r.Output} | {r.origin ?? key.FileName} | {string.Join(", ", r.Items)} | {string.Join("; ", flags)} |");
            }
            md.Add("");
        }
        File.WriteAllText(Path.Combine(dir, "proficiency-report.md"), string.Join("\n", md));
        var json = new JsonObject
        {
            ["plugin"] = key.FileName.String,
            ["loadIndex"] = loadIndex,
            ["markerSpells"] = spells,
            ["errors"] = new JsonArray(Errors.Select(e => (JsonNode)e).ToArray()),
        };
        File.WriteAllText(Path.Combine(dir, "proficiency-ids.json"), json.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }
}
